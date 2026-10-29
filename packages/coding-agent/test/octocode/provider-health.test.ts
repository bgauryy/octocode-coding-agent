import type { Api, AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import {
	checkProviders,
	checkTargets,
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
			/✗ credential refused \(subagent run, .*\): 401.*fix with \/login/,
		);
		health.noteRun("opencode-go/kimi");
		expect(health.get("opencode-go")).toMatchObject({ ok: true });
		expect(describeHealth(health.get("opencode-go"))).toContain("✓ credential worked (subagent run");
	});

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

	it("checks one model per provider: this session's model for its own provider, otherwise the cheapest", () => {
		const parent = model("anthropic", "opus", 5, 25);
		const targets = checkTargets(
			[model("anthropic", "haiku", 1, 5), parent, model("openai", "big", 10, 30), model("openai", "nano", 0.05, 0.4)],
			parent,
		);
		expect(targets.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(["anthropic/opus", "openai/nano"]);
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
		expect(sent[0]).toMatchObject({ options: { maxTokens: 64 } });
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
});
