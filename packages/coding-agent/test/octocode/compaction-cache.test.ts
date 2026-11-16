import { INSTRUCTION_CACHE_RETENTION_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import {
	INFERRED_CACHE_TTL_SECONDS,
	cacheClock,
	inferredPromptCache,
	PromptCacheLifetimes,
	promptCacheTtlMs,
	warmingDecision,
} from "../../src/octocode/compaction/cache.ts";
import { contextChars } from "../../src/octocode/compaction/images.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type TestModel = {
	provider: string;
	id: string;
	api: string;
	promptCache?: { short?: number; long?: number };
	compat?: Record<string, unknown>;
	headers?: Record<string, string>;
	baseUrl?: string;
};

afterEach(() => {
	vi.restoreAllMocks();
});

const opus = (extra: Partial<TestModel> = {}): TestModel => ({
	provider: "gateway",
	id: "claude-opus",
	api: "anthropic-messages",
	// The catalog flag that marks a model as holding the 1h tier; a model without it is planned on 5 minutes.
	compat: { supportsLongCacheRetention: true },
	...extra,
});
const reply = (model: TestModel, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	provider: model.provider,
	model: model.id,
	api: model.api,
	timestamp: Date.now(),
	content: [],
	usage: { input: 4, output: 100, cacheRead: 0, cacheWrite: 0, ...usage },
	stopReason: "toolUse",
	...extra,
});

/** A Octocode double whose registry composes `registerProvider` models the way Octocode does: a registration replaces the provider's models. */
function fakeHost(models: TestModel[]) {
	const handlers = new Map<string, Handler>();
	let catalog = [...models];
	const registerProvider = vi.fn((name: string, config: { models: TestModel[] }) => {
		catalog = [
			...catalog.filter((model) => model.provider !== name),
			...config.models.map((model) => ({ ...model, provider: name })),
		];
	});
	const api = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
			return undefined;
		},
		registerProvider,
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const current = { model: models[0] };
	const usage = { percent: 12 as number | null };
	const ctx = {
		get model() {
			return catalog.find((model) => model.provider === current.model?.provider && model.id === current.model?.id);
		},
		hasUI: true,
		cwd: "/repo",
		modelRegistry: {
			getCachePolicy: () => ({ options: { cacheRetention: "short", instructionCacheRetention: "long" } }),
			getAll: () => catalog,
			find: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
		},
		sessionManager: { getSessionId: () => "s1", getBranch: () => [], getHeader: () => null },
		getContextUsage: () => ({ tokens: 1, contextWindow: 1_000_000, percent: usage.percent }),
	};
	return {
		api,
		ctx,
		handlers,
		registerProvider,
		usage,
		catalog: () => catalog,
		fire: (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx),
	};
}

const turnEnd = (entries: Array<{ id: string; message: unknown }>, message: unknown) => ({
	entries: [],
	message,
	toolResultEntryIds: [],
	context: {
		contextEntries: entries.map((entry) => ({
			sourceEntry: { type: "message", id: entry.id },
			messages: [entry.message],
		})),
	},
});

function compaction(models: TestModel[]) {
	const api = fakeHost(models);
	registerCompaction(api.api, { restore: vi.fn(), forget: vi.fn() } as unknown as FileGuard);
	return api;
}

describe("request size", () => {
	it("counts what the provider is sent: text, thinking with its signature, tool-call arguments and images", () => {
		const entries = [
			{
				id: "a",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "abc", thinkingSignature: "sig45" },
						{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
					],
				},
			},
			{
				id: "r",
				message: {
					role: "toolResult",
					content: [
						{ type: "text", text: "hello" },
						{ type: "image", data: "QUJD", mimeType: "image/png" },
					],
				},
			},
			{ id: "u", message: { role: "user", content: "hi" } },
		];
		const args = { command: "x".repeat(10_000) };
		const withArgs = [
			{
				id: "b",
				message: { role: "assistant", content: [{ type: "toolCall", id: "d", name: "file", arguments: args }] },
			},
		];
		// Thinking text, its signature, the call, the text, the image and the user text all count.
		expect(contextChars(entries)).toBeGreaterThanOrEqual(
			3 + 5 + "bash".length + "command".length + "ls".length + 5 + 4 + 2,
		);
		expect(contextChars(withArgs)).toBeGreaterThanOrEqual(10_000);
		expect(contextChars(withArgs)).toBeLessThanOrEqual(JSON.stringify(args).length + "file".length + 8);
	});
});

describe("prompt-cache lifetimes for models that declare none", () => {
	it("infers the 1h tier only where the model is known to hold it, and the short one otherwise", () => {
		const { short, long } = INFERRED_CACHE_TTL_SECONDS;
		// A model that declares nothing about its long tier takes the safe default.
		expect(inferredPromptCache({})).toEqual({ short, long: short });
		expect(inferredPromptCache({ api: "openai-responses", provider: "x", id: "new-model" })).toEqual({
			short,
			long: short,
		});
		// A catalog flag marks a new model as holding it, whatever its id or API.
		expect(inferredPromptCache({ compat: { supportsLongCacheRetention: true } })).toEqual({ short, long });
		expect(inferredPromptCache({ compat: { supportsLongCacheRetention: true } }, false)).toEqual({
			short,
			long: short,
		});
		expect(inferredPromptCache({ compat: { supportsLongCacheRetention: false } })).toEqual({ short: 300, long: 300 });
		// An Anthropic-protocol gateway gets the adapter's 5-minute default; Anthropic's own host keeps 1h.
		expect(
			inferredPromptCache({
				api: "anthropic-messages",
				baseUrl: "https://openrouter.ai/api/v1",
				provider: "openrouter",
				id: "c",
			}),
		).toEqual({ short: 300, long: 300 });
		expect(
			inferredPromptCache({
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				provider: "anthropic",
				id: "c",
			}).long,
		).toBeGreaterThan(300);
		expect(promptCacheTtlMs({ short: 300, long: 3600 }, {})).toBe(300_000);
		expect(promptCacheTtlMs({ short: 300, long: 3600 }, { [CACHE_RETENTION_ENV]: "long" })).toBe(3_600_000);
		expect(promptCacheTtlMs({ long: 3600 }, {})).toBeUndefined();
		expect(promptCacheTtlMs(undefined, {})).toBeUndefined();
	});

	it("gives an anthropic-messages model that reports cache use lifetimes in Octocode's registry, so Octocode warms its cache", async () => {
		const model = opus();
		const sibling = opus({ id: "claude-haiku" });
		const session = compaction([model, sibling]);
		// No cache activity yet: nothing is invented.
		await session.fire("turn_end", turnEnd([], reply(model, {})));
		expect(session.registerProvider).not.toHaveBeenCalled();
		await session.fire("turn_end", turnEnd([], reply(model, { cacheWrite: 9_000 })));
		expect(session.registerProvider).toHaveBeenCalledOnce();
		const [name, config] = session.registerProvider.mock.calls[0];
		expect(name).toBe("gateway");
		// Every model of the provider stays; only the one that showed caching gains lifetimes, the rest of it unchanged.
		expect(config.models).toEqual([{ ...model, promptCache: { short: 300, long: 3600 } }, sibling]);
		expect(session.ctx.model?.promptCache).toEqual({ short: 300, long: 3600 });
		// Once supplied, later replies register nothing again.
		await session.fire("turn_end", turnEnd([], reply(model, { cacheRead: 9_000 })));
		expect(session.registerProvider).toHaveBeenCalledOnce();
	});

	it("never supplies lifetimes for a model that declares its own, another API, or a provider whose models carry headers", async () => {
		const declared = compaction([opus({ promptCache: { short: 600 } })]);
		await declared.fire("turn_end", turnEnd([], reply(opus(), { cacheRead: 5 })));
		const openai = opus({ api: "openai-completions" });
		const other = compaction([openai]);
		await other.fire("turn_end", turnEnd([], reply(openai, { cacheRead: 5 })));
		const headed = opus({ headers: { "x-team": "a" } });
		const withHeaders = compaction([headed]);
		await withHeaders.fire("turn_end", turnEnd([], reply(headed, { cacheRead: 5 })));
		for (const session of [declared, other, withHeaders]) expect(session.registerProvider).not.toHaveBeenCalled();
	});

	it("keeps the inferred lifetime for idle-warming decisions when the registry refuses the registration, and does not retry it every turn", () => {
		const model = opus();
		const api = fakeHost([model]);
		api.registerProvider.mockImplementation(() => {
			throw new Error("refused");
		});
		const lifetimes = new PromptCacheLifetimes();
		lifetimes.observe(api.api, api.ctx as never, reply(model, { cacheRead: 5 }));
		lifetimes.observe(api.api, api.ctx as never, reply(model, { cacheRead: 5 }));
		expect(api.registerProvider).toHaveBeenCalledOnce();
		expect(lifetimes.of(model as never)).toEqual({ short: 300, long: 3600 });
		// A model never seen caching plans with its resolved tiers: the adapter's 5m and 1h for Anthropic markers on
		// Anthropic's API, 5m for both on a gateway, none for provider-managed caching. Inferred lifetimes stay with the
		// models seen caching. A marker model without a long tier gets its long requests at 5m, so its long tier is the
		// short one, as `inferredPromptCache` gives it.
		expect(lifetimes.of(opus({ id: "never-cached", baseUrl: "https://api.anthropic.com" }) as never)).toEqual({
			short: 300,
			long: 3600,
		});
		expect(lifetimes.of(opus({ id: "never-cached", compat: undefined }) as never)).toEqual({ short: 300, long: 300 });
		expect(lifetimes.of(opus({ id: "never-cached" }) as never)).toEqual({ short: 300, long: 3600 });
		expect(lifetimes.of(opus({ id: "never-cached", api: "mistral-conversations" }) as never)).toBeUndefined();
		expect(lifetimes.of(opus({ id: "never-cached", compat: { supportsLongCacheRetention: false } }) as never)).toEqual({
			short: 300,
			long: 300,
		});
	});
});

describe("granted tier and warming", () => {
	it.each([true, false])("keeps active refresh decisions when hasUI=%s, including subagents", (hasUI) => {
		const ctx = { hasUI, sessionManager: { getBranch: () => [] } } as never;
		for (const action of ["warm", "stop"] as const) {
			expect(
				warmingDecision({ action, warmCost: 0.01, missCost: 1, continuationProbability: 1 }, ctx, 300_000, 0, true),
			).toBeUndefined();
		}
	});

	it("learns from cacheWrite1h that the provider granted only 5 minutes, and supplies a 300 s long tier", () => {
		const model = opus();
		const api = fakeHost([model]);
		const lifetimes = new PromptCacheLifetimes();
		const long = { [CACHE_RETENTION_ENV]: "long" };
		lifetimes.observe(api.api, api.ctx as never, reply(model, { cacheWrite: 900, cacheWrite1h: 900 }), long);
		expect(api.ctx.model?.promptCache).toEqual({ short: 300, long: 3600 });
		lifetimes.observe(api.api, api.ctx as never, reply(model, { cacheWrite: 900, cacheWrite1h: 0 }), long);
		expect(api.registerProvider).toHaveBeenCalledTimes(2);
		expect(api.ctx.model?.promptCache).toEqual({ short: 300, long: 300 });
		expect(lifetimes.of(api.ctx.model as never)).toEqual({ short: 300, long: 300 });
		// Learned once: later replies change nothing.
		lifetimes.observe(api.api, api.ctx as never, reply(model, { cacheWrite: 900, cacheWrite1h: 0 }), long);
		expect(api.registerProvider).toHaveBeenCalledTimes(2);
	});

	it("decides an idle refresh from the session's own idle gaps, and leaves streaming refreshes to Octocode", () => {
		const minute = 60_000;
		const now = 100 * 60 * minute;
		// Ten runs, each followed by a 3-minute pause, and the last reply 1 minute ago.
		const branch = Array.from({ length: 10 }, (_, index) => [
			{ type: "message", message: { role: "assistant", stopReason: "stop", timestamp: index * 10 * minute } },
			{ type: "message", message: { role: "user", timestamp: index * 10 * minute + 3 * minute } },
		]).flat();
		branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", timestamp: now - minute } });
		const ctx = { hasUI: true, sessionManager: { getBranch: () => branch } } as never;
		const idle = { action: "stop" as const, warmCost: 0.02, missCost: 0.5, continuationProbability: 0.15 };
		// Every pause ended between 1.5 and 6 minutes: q = 1, so a 5-minute entry is worth refreshing.
		expect(warmingDecision(idle, ctx, 5 * minute, now)).toEqual({ action: "warm" });
		// An hour-long entry outlives every pause without a refresh this early: the expected return is before 0.1τ.
		expect(warmingDecision({ ...idle, action: "warm" }, ctx, 60 * minute, now)).toEqual({ action: "stop" });
		expect(warmingDecision({ ...idle, continuationProbability: 1 }, ctx, 5 * minute, now)).toBeUndefined();
		expect(
			warmingDecision(
				{ ...idle, action: "warm" },
				{ hasUI: false, sessionManager: { getBranch: () => branch } } as never,
				5 * minute,
				now,
			),
		).toEqual({ action: "stop" });
		// A subagent reports a UI over RPC but nobody idles at it: it never keeps a cache warm, by argument or by its env.
		expect(warmingDecision({ ...idle, action: "warm" }, ctx, 5 * minute, now, true)).toEqual({ action: "stop" });
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		try {
			expect(warmingDecision({ ...idle, action: "warm" }, ctx, 5 * minute, now)).toEqual({ action: "stop" });
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("cache retention", () => {
	it("inherits explicit user values without inventing environment defaults", () => {
		expect(subagentProcessEnv(undefined, {})[CACHE_RETENTION_ENV]).toBeUndefined();
		expect(subagentProcessEnv(undefined, { [CACHE_RETENTION_ENV]: "long" })[CACHE_RETENTION_ENV]).toBe("long");
	});
	it("passes both resolved parent preferences to a child", () => {
		const env = subagentProcessEnv(
			undefined,
			{},
			{
				id: "child",
				cachePreferences: { cacheRetention: "short", instructionCacheRetention: "long" },
			},
		);
		expect(env[CACHE_RETENTION_ENV]).toBe("short");
		expect(env[INSTRUCTION_CACHE_RETENTION_ENV]).toBe("long");
	});
});

describe("cache clock evidence", () => {
	it("uses cache request dispatch time when a warm receipt arrives later", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", stopReason: "stop", timestamp: 1_000 } },
			{
				type: "usage",
				kind: "cache_warm",
				timestamp: new Date(310_000).toISOString(),
				cacheRequestedAt: new Date(270_000).toISOString(),
				usage: { cacheRead: 100, cacheWrite: 0 },
			},
		];
		expect(cacheClock({ getBranch: () => branch }).useAt).toBe(270_000);
	});
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid lifetime %s", (short) => {
		expect(promptCacheTtlMs({ short }, {})).toBeUndefined();
	});
	it("does not renew cache lifetime for a refresh reporting neither a read nor a write", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", stopReason: "stop", timestamp: 1000 } },
			{
				type: "usage",
				kind: "cache_warm",
				timestamp: new Date(2000).toISOString(),
				usage: { cacheRead: 0, cacheWrite: 0 },
			},
		];
		expect(cacheClock({ getBranch: () => branch }).useAt).toBe(1000);
	});
});

describe("failed requests after cache expiry", () => {
	it.each(["error", "aborted"])("does not renew the cache for a %s reply without cache activity", (stopReason) => {
		const branch = [
			{
				type: "message",
				message: { role: "assistant", stopReason: "stop", timestamp: 1_000, usage: { cacheRead: 100, cacheWrite: 0 } },
			},
			{
				type: "message",
				message: { role: "assistant", stopReason, timestamp: 400_000, usage: { cacheRead: 0, cacheWrite: 0 } },
			},
		];
		const clock = cacheClock({ getBranch: () => branch });
		expect(clock.replyAt).toBe(400_000);
		expect(clock.useAt).toBe(1_000);
	});

	it("keeps a failed stream's cache use when the provider reported it before the failure", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "aborted",
					timestamp: 400_000,
					usage: { cacheRead: 100, cacheWrite: 0 },
				},
			},
		];
		expect(cacheClock({ getBranch: () => branch }).useAt).toBe(400_000);
	});
});
