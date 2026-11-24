import { streamSimple } from "@octocodeai/octocode-ai/compat";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	isRetryableErrorText,
	isUsageLimitError,
	type Model,
	type Provider,
} from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentDbCooldownStore, type Cooldown, type CooldownStore } from "../src/core/model-runtime/cooldown-store.ts";
import { cooldownStep } from "../src/core/model-runtime/cooldown-request.ts";
import {
	COOLDOWN_INITIAL_MS,
	COOLDOWN_MAX_MS,
	COOLDOWN_RETRY_AFTER_MAX_MS,
	coolsDown,
	nextCooldown,
	ProviderCooldowns,
	providerCooldowns,
} from "../src/core/model-runtime/provider-cooldown.ts";
import { type ModelRequestHost, streamSimpleChatModel } from "../src/core/model-runtime/requests.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A store two "processes" share, kept like the database row: the later end wins, with its pause. */
function sharedStore(): CooldownStore & { rows: Map<string, Cooldown> } {
	const rows = new Map<string, Cooldown>();
	return {
		rows,
		read: (provider) => rows.get(provider),
		write: async (provider, cooldown) => {
			const stored = rows.get(provider);
			if (!stored || cooldown.until >= stored.until) rows.set(provider, cooldown);
		},
	};
}

function clockAt(start = 1_000_000) {
	const clock = { now: start };
	return { clock, now: () => clock.now };
}

describe("the next cool-down", () => {
	const at = 1_000_000;

	it("pauses briefly, doubling only for a request that went out after the last pause ended, up to a cap", () => {
		let cooldown = nextCooldown(undefined, { now: at, startedAt: at - 100 });
		expect(cooldown).toEqual({ until: at + COOLDOWN_INITIAL_MS, pauseMs: COOLDOWN_INITIAL_MS });
		// Siblings already out during the pause met the same throttle: the pause does not grow, its end moves with the last.
		cooldown = nextCooldown(cooldown, { now: at + 500, startedAt: at - 50 });
		expect(cooldown).toEqual({ until: at + 500 + COOLDOWN_INITIAL_MS, pauseMs: COOLDOWN_INITIAL_MS });
		// A request sent after the pause ended was refused again: the pause was too short.
		const sent = cooldown.until;
		cooldown = nextCooldown(cooldown, { now: sent + 10, startedAt: sent });
		expect(cooldown.pauseMs).toBe(2 * COOLDOWN_INITIAL_MS);
		for (let i = 0; i < 10; i++) cooldown = nextCooldown(cooldown, { now: cooldown.until, startedAt: cooldown.until });
		expect(cooldown.pauseMs).toBe(COOLDOWN_MAX_MS);
	});

	it("keeps the provider's own wait exactly, never moves an end earlier, and starts over after a calm minute", () => {
		const asked = nextCooldown(undefined, { now: at, retryAfterMs: 45_000 });
		expect(asked).toEqual({ until: at + 45_000, pauseMs: 0 });
		expect(nextCooldown(asked, { now: at + 1_000, startedAt: at }).until).toBe(at + 45_000);
		const long = { until: at, pauseMs: 16_000 };
		expect(nextCooldown(long, { now: at + 60_001, startedAt: at + 60_000 })).toEqual({
			until: at + 60_001 + COOLDOWN_INITIAL_MS,
			pauseMs: COOLDOWN_INITIAL_MS,
		});
	});

	it("holds a longer provider wait only up to its cap, so a stale record cannot block the provider for long", () => {
		const hour = nextCooldown(undefined, { now: at, retryAfterMs: 3_600_000 });
		expect(hour.until).toBe(at + COOLDOWN_RETRY_AFTER_MAX_MS);
		// The request sent once it ends gets the provider's answer, which sets the next one.
		const next = nextCooldown(hour, { now: hour.until + 10, startedAt: hour.until, retryAfterMs: 20_000 });
		expect(next.until).toBe(hour.until + 10 + 20_000);
	});

	it("comes from a rate limit, never from a usage or billing limit", () => {
		expect(coolsDown('429 {"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}')).toBe(true);
		expect(coolsDown("Too many requests")).toBe(true);
		expect(coolsDown("429 insufficient_quota: You exceeded your current quota")).toBe(false);
		expect(coolsDown("503 overloaded")).toBe(false);
		expect(coolsDown(undefined)).toBe(false);
	});
});

describe("provider cool-downs", () => {
	it("are shared through the store, per provider: a rate limit on one never holds another", () => {
		const store = sharedStore();
		const { clock, now } = clockAt();
		const parent = new ProviderCooldowns(() => store, now);
		const child = new ProviderCooldowns(() => store, now);
		child.record("anthropic", { startedAt: clock.now });
		expect(parent.remainingMs("anthropic")).toBe(COOLDOWN_INITIAL_MS);
		expect(parent.remainingMs("openai")).toBe(0);
		// The parent's sibling failing on the same throttle computes from the shared row: no second doubling.
		clock.now += 300;
		parent.record("anthropic", { startedAt: clock.now - 1_000 });
		expect(store.rows.get("anthropic")?.pauseMs).toBe(COOLDOWN_INITIAL_MS);
	});

	it("keep working from this process's copy when the store fails, and say so once", () => {
		const onStoreError = vi.fn();
		const { now } = clockAt();
		const cooldowns = new ProviderCooldowns(
			() => {
				throw new Error("database unusable");
			},
			now,
			onStoreError,
		);
		cooldowns.record("anthropic", { retryAfterMs: 5_000 });
		expect(cooldowns.remainingMs("anthropic")).toBe(5_000);
		expect(cooldowns.remainingMs("openai")).toBe(0);
		expect(onStoreError).toHaveBeenCalledTimes(1);
	});

	it("wait only what is left, tell when the wait starts and ends, and give up on abort", async () => {
		vi.useFakeTimers();
		const store = sharedStore();
		const cooldowns = new ProviderCooldowns(() => store);
		cooldowns.record("anthropic", { retryAfterMs: 3_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const heard: (number | undefined)[] = [];
		let done = false;
		const waiting = cooldowns.wait("anthropic", { onWait: (until) => heard.push(until) }).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(1_999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(heard).toEqual([Date.now(), undefined]);

		cooldowns.record("anthropic", { retryAfterMs: 3_000 });
		const controller = new AbortController();
		const aborted = cooldowns.wait("anthropic", { signal: controller.signal });
		const assertion = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await assertion;
	});

	it("spreads simultaneous requests after the shared deadline, within the caller's wait limit", async () => {
		vi.useFakeTimers();
		const cooldowns = new ProviderCooldowns(() => sharedStore());
		cooldowns.record("anthropic", { retryAfterMs: 4_000 });
		vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.75);
		const start = Date.now();
		const sent: number[] = [];
		const send = () => cooldowns.wait("anthropic", { maxWaitMs: 4_200 }).then(() => sent.push(Date.now() - start));
		const calls = Promise.all([send(), send()]);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(sent).toEqual([4_000]);
		await vi.advanceTimersByTimeAsync(200);
		await calls;
		expect(sent[1]).toBeGreaterThan(4_000);
		expect(sent[1]).toBeLessThanOrEqual(4_200);
	});

	it("allows a full quota window after repeated 429s on Bedrock's OpenAI-compatible endpoint", async () => {
		vi.useFakeTimers();
		const cooldowns = new ProviderCooldowns(() => sharedStore());
		const bedrock = {
			...model("custom"),
			api: "openai-completions" as const,
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
		};
		const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too many requests" });
		for (const pause of [2, 4, 8, 16, 32, 60, 60]) {
			// Auth selects the physical endpoint after the model was chosen.
			const step = cooldownStep(model("custom"), undefined, cooldowns);
			await step.ready(bedrock);
			step.observer.onEvent?.({ type: "error", reason: "error", error });
			expect(cooldowns.remainingMs("custom")).toBe(pause * 1_000);
			await vi.advanceTimersByTimeAsync(pause * 1_000);
		}
	});

	it("refuse a wait longer than the caller accepts, without waiting", async () => {
		const cooldowns = new ProviderCooldowns(() => sharedStore());
		cooldowns.record("anthropic", { retryAfterMs: 45_000 });
		const refusal = await cooldowns.wait("anthropic", { maxWaitMs: 30_000 });
		expect(refusal?.provider).toBe("anthropic");
		expect(refusal?.remainingMs).toBeGreaterThan(30_000);
		expect(await cooldowns.wait("openai", { maxWaitMs: 30_000 })).toBeUndefined();
	});
});

const model = (provider: string): Model<Api> => ({
	id: "m",
	name: "m",
	api: "anthropic-messages",
	provider,
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
});

function failed(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "error", reason: "error", error: message });
		stream.end(message);
	});
	return stream;
}

/** A host whose provider answers each request with the next reply. */
function hostAnswering(
	replies: AssistantMessage[],
	send?: Provider["streamSimple"],
): ModelRequestHost & { sent: number[] } {
	const sent: number[] = [];
	const provider = {
		streamSimple:
			send ??
			(() => {
				sent.push(Date.now());
				const reply = replies.shift() ?? fauxAssistantMessage("done");
				if (reply.stopReason === "error") return failed(reply);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: reply });
					stream.end(reply);
				});
				return stream;
			}),
	} as unknown as Provider;
	return {
		sent,
		getProvider: () => provider,
		getAuth: async () => ({ auth: { apiKey: "key" } }),
		getCachePolicy: () => ({ options: {} }) as ReturnType<ModelRequestHost["getCachePolicy"]>,
		resolveModel: async () => {
			throw new Error("not routed");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

describe("a chat request through the runtime", () => {
	it("blocks a sibling model before a real adapter retries and succeeds", async () => {
		const provider = `retry-sibling-${process.pid}-${Date.now()}`;
		const first = { ...model(provider), api: "openai-completions" as const };
		const host = hostAnswering([], streamSimple);
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("Too many requests", { status: 429, headers: { "retry-after-ms": "150" } }))
			.mockResolvedValueOnce(
				new Response(
					'data: {"id":"ok","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
			);
		const observed: AssistantMessage[] = [];
		const result = await streamSimpleChatModel(
			host,
			first,
			{ messages: [] },
			{
				maxRetries: 1,
				fetch,
				async onRateLimit() {
					observed.push(
						await streamSimpleChatModel(
							host,
							{ ...first, id: "sibling" },
							{ messages: [] },
							{ maxRetryDelayMs: 1, fetch },
						).result(),
					);
				},
			},
		).result();
		expect(observed, result.errorMessage).toHaveLength(1);
		expect(observed[0].errorMessage).toContain("was not sent");
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("shares a physical 429 immediately and rechecks peers before a transport retry", async () => {
		vi.useFakeTimers();
		const store = sharedStore();
		const a = new ProviderCooldowns(() => store);
		const b = new ProviderCooldowns(() => store);
		const observe = vi.fn();
		const request = cooldownStep(model("shared"), { onRateLimit: observe }, a);
		await request.ready();
		await request.hooks.onRateLimit?.(500);
		expect(observe).toHaveBeenCalledWith(500);
		expect(b.remainingMs("shared")).toBe(500);
		await vi.advanceTimersByTimeAsync(500);
		b.record("shared", { retryAfterMs: 1000 });
		const admitted = vi.fn();
		const retry = Promise.resolve(request.hooks.onTransportRetry?.()).then(admitted);
		expect(await cooldownStep(model("other"), undefined, a).ready()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(999);
		expect(admitted).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(501);
		await retry;
		expect(admitted).toHaveBeenCalledOnce();
	});

	it("records its provider's cool-down on a rate limit, and the next request waits it out", async () => {
		const provider = `cooldown-test-${process.pid}-${Date.now()}`;
		const limited = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too many requests" }),
			retryAfterMs: 200,
		};
		const host = hostAnswering([limited]);
		const first = await streamSimpleChatModel(host, model(provider), { messages: [] }).result();
		expect(first.stopReason).toBe("error");
		expect(providerCooldowns.remainingMs(provider)).toBeGreaterThan(100);
		// Another process sees it in the agent database once the writer committed it.
		await vi.waitFor(() => expect(agentDbCooldownStore().read(provider)?.until).toBeGreaterThan(Date.now()));
		const waits: unknown[] = [];
		const second = await streamSimpleChatModel(
			host,
			model(provider),
			{ messages: [] },
			{
				onCooldownWait: (wait) => waits.push(wait),
			},
		).result();
		expect(second.stopReason).toBe("stop");
		expect(host.sent[1] - host.sent[0]).toBeGreaterThanOrEqual(190);
		expect(waits).toEqual([{ provider, until: expect.any(Number) }, undefined]);
	});

	it("fails unsent, naming the wait, when the cool-down is longer than the request accepts", async () => {
		const provider = `cooldown-long-${process.pid}-${Date.now()}`;
		providerCooldowns.record(provider, { retryAfterMs: 50_000 });
		const host = hostAnswering([]);
		const result = await streamSimpleChatModel(
			host,
			model(provider),
			{ messages: [] },
			{ maxRetryDelayMs: 30_000 },
		).result();
		expect(host.sent).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBeGreaterThan(30_000);
		expect(result.errorMessage).toMatch(/cooling down from a rate limit for (49|50)s more/);
		// The session retry reads it as a rate limit, not as a usage limit that would switch models.
		expect(isRetryableErrorText(result.errorMessage!)).toBe(true);
		expect(isUsageLimitError(result.errorMessage!)).toBe(false);
		// A request that never went out leaves the cool-down as it was.
		const until = providerCooldowns.current(provider)?.until;
		await streamSimpleChatModel(host, model(provider), { messages: [] }, { maxRetryDelayMs: 30_000 }).result();
		expect(providerCooldowns.current(provider)?.until).toBe(until);
	});

	it("ends aborted when its signal aborts the wait, and records nothing for a usage limit", async () => {
		const cooldowns = new ProviderCooldowns(() => sharedStore());
		cooldowns.record("anthropic", { retryAfterMs: 30_000 });
		const controller = new AbortController();
		const step = cooldownStep(model("anthropic"), { signal: controller.signal }, cooldowns);
		const ready = step.ready();
		controller.abort();
		await expect(ready).rejects.toMatchObject({ name: "AbortError" });

		const quota = new ProviderCooldowns(() => sharedStore());
		const sent = cooldownStep(model("openai"), undefined, quota);
		expect(await sent.ready()).toBeUndefined();
		const quotaError = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 insufficient_quota" });
		sent.observer.onEvent?.({ type: "error", reason: "error", error: quotaError });
		expect(quota.remainingMs("openai")).toBe(0);
	});
});
