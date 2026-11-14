import type { Api, AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import {
	checkCandidates,
	checkProviders,
	describeHealth,
	ProviderHealth,
} from "../../src/octocode/subagents/provider-health.ts";

const model = (provider: string, id: string, input: number, output: number) =>
	({ provider, id, cost: { input, output } }) as unknown as Model<Api>;

describe("provider health", () => {
	it("marks a provider after a credential refusal and clears it after a successful run", () => {
		const health = new ProviderHealth();
		health.noteRun("opencode-go/kimi", '401: {"code":"api_key_expired","message":"This API key has expired."}');
		expect(health.get("opencode-go")).toMatchObject({ ok: false, via: "run" });
		expect(describeHealth(health.get("opencode-go"))).toMatch(
			/✗ credential refused \(subagent run, .*\): 401.*fix with \/providers/,
		);
		health.noteRun("opencode-go/kimi");
		expect(health.get("opencode-go")).toMatchObject({ ok: true });
		expect(describeHealth(health.get("opencode-go"))).toContain("✓ credential worked (subagent run");
	});

	it.each(["subscription_sharing_usage_limit_exceeded", "Monthly usage limit reached", "429 quota exceeded"])(
		"steers routing away from a provider whose account hit a usage limit: %s",
		(error) => {
			const health = new ProviderHealth();
			health.noteRun("openai-chatgpt/gpt", error);
			expect(health.refused("openai-chatgpt")).toBe(true);
			expect(health.refused("openai-chatgpt", "gpt", true)).toBe(false);
			expect(describeHealth(health.get("openai-chatgpt"))).toMatch(
				/✗ usage limit reached .*wait for the limit to reset/,
			);
		},
	);

	it("redacts credentials echoed in provider errors and keeps the rest of the text", () => {
		const health = new ProviderHealth();
		const key = `sk-proj-${"a1B2".repeat(10)}`;
		const tail = " — see https://example.test/errors for details.".repeat(5);
		health.noteCheck("openai", `401 Incorrect API key provided: ${key}.${tail}`);
		const detail = health.get("openai")?.detail ?? "";
		expect(detail).not.toContain(key);
		expect(detail).toContain("[redacted]");
		expect(detail.endsWith("for details.")).toBe(true);
	});

	it("ignores failures that say nothing about the credential and runs on this session's model", () => {
		const health = new ProviderHealth();
		health.noteRun("openai/gpt", "Tool loop exceeded its budget");
		health.noteRun(undefined, "401 unauthorized");
		expect(health.get("openai")).toBeUndefined();
		expect(describeHealth(undefined)).toBe("");
	});

	it("orders each provider's models: this session's model for its own provider first, otherwise the cheapest", () => {
		const parent = model("anthropic", "opus", 5, 25);
		const targets = checkCandidates(
			[model("anthropic", "haiku", 1, 5), parent, model("openai", "big", 10, 30), model("openai", "nano", 0.05, 0.4)],
			parent,
		);
		expect(targets.map((models) => models.map((entry) => `${entry.provider}/${entry.id}`))).toEqual([
			["anthropic/opus", "anthropic/haiku"],
			["openai/nano", "openai/big"],
		]);
		expect(checkCandidates([parent, model("anthropic", "haiku", 1, 5)], parent, 1)).toEqual([[parent]]);
	});

	it("records each provider's answer to a tiny request, including thrown and reported errors", async () => {
		const health = new ProviderHealth();
		const replies: Record<string, () => Promise<Partial<AssistantMessage>>> = {
			good: async () => ({ stopReason: "stop" }),
			expired: async () => ({ stopReason: "error", errorMessage: "401 api_key_expired" }),
			broken: async () => {
				throw new Error("socket hang up");
			},
		};
		const sent: unknown[] = [];
		const registry = {
			streamSimple: (target: Model<Api>, context: unknown, options: unknown) => {
				sent.push({ context, options });
				return { result: replies[target.provider] } as never;
			},
		};
		await checkProviders(
			registry,
			[model("good", "a", 1, 1), model("expired", "b", 1, 1), model("broken", "c", 1, 1)],
			health,
		);
		expect(health.get("good")).toMatchObject({ ok: true, via: "check" });
		expect(describeHealth(health.get("expired"))).toContain("✗ credential refused (check");
		expect(describeHealth(health.get("broken"))).toContain("✗ check failed (check");
		expect(describeHealth(health.get("broken"))).toContain("socket hang up");
		expect(sent).toHaveLength(3);
		expect(sent[0]).toMatchObject({
			options: { maxTokens: 64, sessionId: expect.stringMatching(/^credential-check-/) },
		});
	});

	it("accepts a credential by its model list without inference, and confirms a failed list with a request", async () => {
		const health = new ProviderHealth();
		const fetch = vi.fn(async (url: URL | string) =>
			String(url).startsWith("https://api.deepseek.com")
				? Response.json({ data: [{ id: "deepseek-v4-pro" }] })
				: new Response('{"error":{"message":"bad key sk-proj-abcdefghijklmnopqrstuvwxyz"}}', { status: 401 }),
		);
		vi.stubGlobal("fetch", fetch);
		try {
			const streamSimple = vi.fn((target: Model<Api>) => ({
				result: async () => ({ stopReason: "error", errorMessage: `401 unauthorized for ${target.provider}` }),
			}));
			const providers: Record<string, { id: string; baseUrl: string }> = {
				deepseek: { id: "deepseek", baseUrl: "https://api.deepseek.com" },
				groq: { id: "groq", baseUrl: "https://api.groq.com/openai/v1" },
			};
			const registry = {
				streamSimple: streamSimple as never,
				getProvider: (id: string) => ({ ...providers[id], getModels: () => [] }) as never,
				getProviderAuth: async () => ({ auth: { apiKey: "key" }, source: "environment" }) as never,
			};
			await checkProviders(registry, [model("deepseek", "a", 1, 1), model("groq", "b", 1, 1)], health);
			expect(streamSimple).toHaveBeenCalledTimes(1);
			expect(streamSimple.mock.calls[0][0].provider).toBe("groq");
			expect(health.get("deepseek")).toMatchObject({ ok: true, via: "list" });
			expect(describeHealth(health.get("deepseek"))).toContain("credential accepted (model list");
			expect(health.get("groq")).toMatchObject({ ok: false, via: "check" });
			expect(describeHealth(health.get("groq"))).not.toContain("bad key");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("marks insufficient funds as a billing refusal, not a credential one", () => {
		const health = new ProviderHealth();
		health.noteRun("opencode-go/glm", '402 {"error":{"message":"Insufficient account funds"}}');
		expect(health.refused("opencode-go")).toBe(true);
		const text = describeHealth(health.get("opencode-go"));
		expect(text).toMatch(/✗ out of funds .*add funds or a plan/);
		expect(text).not.toContain("/providers");
		// A request-shape rejection marks neither the provider nor its credential.
		const other = new ProviderHealth();
		other.noteRun("opencode-go/glm", "400 Upstream request failed: [invalid_request_error] Invalid request");
		expect(other.get("opencode-go")).toBeUndefined();
	});

	it("keeps a run's billing refusal when the model list accepts the key", async () => {
		const health = new ProviderHealth();
		health.noteRun("deepseek/a", "429 insufficient_quota: add credit");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [{ id: "a" }] })),
		);
		try {
			const registry = {
				streamSimple: vi.fn() as never,
				getProvider: () => ({ id: "deepseek", baseUrl: "https://api.deepseek.com", getModels: () => [] }) as never,
				getProviderAuth: async () => ({ auth: { apiKey: "key" }, source: "environment" }) as never,
			};
			await checkProviders(registry, [model("deepseek", "a", 1, 1)], health);
			expect(health.get("deepseek")).toMatchObject({ ok: false, via: "run" });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("tries the provider's next model when the first is refused for itself, but not after a credential refusal", async () => {
		const health = new ProviderHealth();
		const tried: string[] = [];
		const errors: Record<string, string | undefined> = {
			"go/contributor": "400 This Go model trains on request data. Allow paid endpoints that train on request data.",
			"go/open": undefined,
			"key/a": "401 unauthorized",
			"key/b": undefined,
		};
		const registry = {
			streamSimple: (target: Model<Api>) => {
				const id = `${target.provider}/${target.id}`;
				tried.push(id);
				const errorMessage = errors[id];
				return {
					result: async () => (errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" }),
				} as never;
			},
		};
		const available = [
			model("go", "open", 0.14, 0.28),
			model("go", "contributor", 0.1, 0.2),
			model("key", "a", 1, 1),
			model("key", "b", 2, 2),
		];
		await checkProviders(registry, checkCandidates(available, undefined), health);
		// Providers run in parallel: compare the set, and the order within one provider.
		expect([...tried].sort()).toEqual(["go/contributor", "go/open", "key/a"]);
		expect(tried.indexOf("go/contributor")).toBeLessThan(tried.indexOf("go/open"));
		expect(health.get("go")).toMatchObject({ ok: true, via: "check" });
		expect(describeHealth(health.get("key"))).toContain("✗ credential refused (check");
	});

	it("records nothing when the caller cancels the check", async () => {
		const health = new ProviderHealth();
		const controller = new AbortController();
		const registry = {
			streamSimple: () =>
				({
					result: async () => {
						controller.abort(new Error("stopped"));
						return { stopReason: "aborted" };
					},
				}) as never,
		};
		await expect(checkProviders(registry, [model("p", "m", 1, 1)], health, controller.signal)).rejects.toThrow(
			"stopped",
		);
		expect(health.get("p")).toBeUndefined();
	});

	it("tries a sibling after a model-specific 403 instead of rejecting the provider credential", async () => {
		const health = new ProviderHealth();
		const tried: string[] = [];
		const registry = {
			streamSimple: (target: Model<Api>) => {
				tried.push(target.id);
				return {
					result: async () =>
						target.id === "restricted"
							? { stopReason: "error", errorMessage: "403 You do not have access to model restricted" }
							: { stopReason: "stop" },
				} as never;
			},
		};
		await checkProviders(registry, [[model("gateway", "restricted", 1, 1), model("gateway", "allowed", 2, 2)]], health);
		expect(tried).toEqual(["restricted", "allowed"]);
		expect(health.get("gateway")).toMatchObject({ ok: true, via: "check" });
		expect(health.refused("gateway", "allowed")).toBe(false);
	});
});
