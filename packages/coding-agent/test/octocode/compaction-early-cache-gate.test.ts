import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import type { FeatureSetup } from "../../src/core/features/index.ts";
import type * as EarlySummary from "../../src/octocode/compaction/early-summary.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { asSetup, fakeCachePolicy } from "./fake-host.ts";

/** The `cold` flag each early-summary start received from the prewarm handler. */
const started = vi.hoisted(() => [] as boolean[]);
vi.mock("../../src/octocode/compaction/early-summary.ts", async (importOriginal) => ({
	...(await importOriginal<typeof EarlySummary>()),
	startEarlySummary: (_api: unknown, _event: unknown, _ctx: unknown, cold: boolean) => {
		started.push(cold);
	},
}));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
// Kimi K3.1 on Bedrock: it caches on its own terms and declares no lifetime.
const kimi = getBuiltinModel("amazon-bedrock", "global.moonshotai.kimi-k3.1");

function prewarmWith(replyAgoMs: number, cacheRead: number) {
	started.length = 0;
	const handlers = new Map<string, Handler>();
	const api = asSetup({
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
			return undefined;
		},
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
	}) as unknown as FeatureSetup;
	registerCompaction(api, { restore: vi.fn(), forget: vi.fn() } as unknown as FileGuard);
	const reply = {
		type: "message",
		id: "a1",
		message: {
			role: "assistant",
			timestamp: Date.now() - replyAgoMs,
			stopReason: "toolUse",
			usage: { input: 2_000, output: 100, cacheRead, cacheWrite: 0 },
		},
	};
	const ctx = {
		model: kimi,
		modelRegistry: { getCachePolicy: fakeCachePolicy },
		cwd: "/repo",
		hasUI: false,
		sessionManager: { getSessionId: () => "s1", getBranch: () => [reply] },
	};
	return handlers.get("session_compact_prewarm")!({ type: "session_compact_prewarm" }, ctx);
}

describe("early summary on a model without a declared cache lifetime", () => {
	it("starts warm right after a reply that read the cache", async () => {
		await prewarmWith(3_000, 207_000);
		expect(started).toEqual([false]);
	});

	it("starts cold when the replies show no caching or the last cache use is past five minutes", async () => {
		await prewarmWith(3_000, 0);
		expect(started).toEqual([true]);
		await prewarmWith(6 * 60_000, 207_000);
		expect(started).toEqual([true]);
	});
});
