import { describe, expect, it, vi } from "vitest";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { RECOVERY_BAND } from "../../src/octocode/compaction/pacing.ts";
import { autoCompactAt } from "../../src/octocode/shared/tokens.ts";
import { asSetup, fakeCachePolicy } from "./fake-host.ts";

/** The recovery band through the real `session_compact` and `session_before_compact` handlers. */

const model = { provider: "p", id: "m", api: "anthropic-messages", contextWindow: 200_000 };
const TRIGGER = autoCompactAt(model, { level: "off" });

function session() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	let tokens: number | null = 0;
	const api = asSetup({
		on: (name: string, handler: never) => {
			handlers.set(name, handler);
			return undefined;
		},
		appendEntry: vi.fn(),
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
		getActiveTools: () => [],
		getAllTools: () => [],
		sendMessage: vi.fn(),
	});
	const requests = registerCompaction(api, { restore: vi.fn(), forget: vi.fn(), record: vi.fn() } as never);
	const ctx = {
		cwd: "/w",
		hasUI: false,
		ui: { notify: vi.fn() },
		abort: vi.fn(),
		failRun: vi.fn(),
		compact: vi.fn(),
		model,
		modelRegistry: { getCachePolicy: fakeCachePolicy },
		getContextUsage: () => ({ tokens, contextWindow: model.contextWindow, percent: 0 }),
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ contextFiles: [] }),
		sessionManager: {
			getSessionId: () => "s",
			getBranch: () => [],
			buildSessionProjection: () => ({ entries: [], messages: [] }),
			getSessionFile: () => undefined,
		},
	};
	const fire = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
	return {
		ctx,
		/** The agent's own request (`compact` tool), started when its run settles: the compaction it runs is in flight. */
		toolRequest: async () => {
			requests.request(undefined);
			await fire("agent_settled", { aborted: false });
		},
		/** A finished automatic compaction that left `share` of the trigger in the context. */
		compactedTo: async (share: number, reason = "threshold") => {
			tokens = Math.round(share * TRIGGER);
			await fire("session_compact", { reason });
		},
		beforeCompact: (reason: string) =>
			fire("session_before_compact", {
				reason,
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				},
				branchEntries: [],
				signal: new AbortController().signal,
			}),
	};
}

describe("recovery band through the session's compaction events", () => {
	it("refuses the next threshold compaction after one that left the context above the band", async () => {
		const s = session();
		await s.compactedTo(RECOVERY_BAND + 0.1);
		expect(await s.beforeCompact("threshold")).toMatchObject({ cancel: true });
	});

	it("allows the next threshold compaction after one that left the context within the band", async () => {
		const s = session();
		await s.compactedTo(RECOVERY_BAND - 0.1);
		expect(await s.beforeCompact("threshold")).not.toMatchObject({ cancel: true });
	});

	it("still compacts for an overflow right after a compaction that left the context above the band", async () => {
		const s = session();
		await s.compactedTo(RECOVERY_BAND + 0.1);
		expect(await s.beforeCompact("overflow")).not.toMatchObject({ cancel: true });
		expect(s.ctx.abort).not.toHaveBeenCalled();
		expect(s.ctx.failRun).not.toHaveBeenCalled();
	});

	it("still runs the compact tool's own compaction right after a compaction that left the context above the band", async () => {
		const s = session();
		await s.compactedTo(RECOVERY_BAND + 0.1);
		await s.toolRequest();
		expect(s.ctx.compact).toHaveBeenCalled();
		expect(await s.beforeCompact("manual")).not.toMatchObject({ cancel: true });
	});

	it("lifts the refusal once a later compaction lands within the band", async () => {
		const s = session();
		await s.compactedTo(RECOVERY_BAND + 0.1);
		await s.compactedTo(RECOVERY_BAND - 0.1, "overflow");
		expect(await s.beforeCompact("threshold")).not.toMatchObject({ cancel: true });
	});
});
