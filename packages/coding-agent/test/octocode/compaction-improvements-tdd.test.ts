import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { finalizeCompactionResult } from "../../src/core/compaction/checkpoint.ts";
import { findProjectedCutPoint } from "../../src/core/compaction/cut-point.ts";
import { applyLedger, carryLedger, ledgerOf } from "../../src/core/compaction/ledger.ts";
import { restates, wordsOf } from "../../src/core/compaction/ledger-match.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { userMessagesSection } from "../../src/octocode/compaction/checkpoint-text.ts";
import { clearableResults } from "../../src/octocode/compaction/clearing-candidates.ts";
import { inRecentUse } from "../../src/octocode/compaction/clearing-recent.ts";
import { archivedPreviousNote, boundaryNote } from "../../src/octocode/compaction/shared-summary.ts";
import { noticeContextUsage } from "../../src/octocode/monitor/attention/context.ts";

describe("Compaction accuracy, cut-points, ledger & clearing (TDD)", () => {
	it("sizes finalizeCompactionResult with the target model's tokenizer ratio instead of hardcoding 2.5 chars/token", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
		const keptId = sm.appendMessage({
			role: "user",
			content: "x".repeat(280_000), // 80k tokens on OpenAI (3.5 chars/token), 112k at default 2.5
			timestamp: 2,
		});

		const finalized = finalizeCompactionResult(
			{
				summary: "## Goal\nShip fix\n\n## TL;DR\nDone.",
				firstKeptEntryId: keptId,
				tokensBefore: 105_000,
			},
			{
				branchEntries: sm.getBranch(),
				contextWindow: 120_000,
				reserveTokens: 16_384,
				model: { provider: "openai", id: "gpt-5.4" },
			},
		);
		expect(finalized.firstKeptEntryId).toBe(keptId);
	});

	it("emits boundaryNote across context-invisible cut entries and strips ## User Messages in archivedPreviousNote", () => {
		const entries = [
			{ sourceEntry: { id: "invisible-cut", type: "custom" }, messages: [] },
			{
				sourceEntry: { id: "visible-next", type: "custom_message" },
				messages: [{ role: "custom", customType: "note", content: "Build output verified", display: true }],
			},
		];
		const note = boundaryNote(entries, "invisible-cut");
		expect(note).toContain("Summarize only the conversation before");
		expect(note).toContain("Build output verified");

		const archivedEntries = [
			{
				sourceEntry: {
					id: "comp-1",
					type: "compaction",
					details: {
						checkpointArchive: {
							path: "/tmp/cp.md",
							summary:
								"## Goal\nKeep auth safe\n\n## User Messages\n<user-message>\nsecret giant user dump\n</user-message>\n\n## Recovery\n- saved",
						},
					},
				},
				messages: [{ role: "compactionSummary", summary: "ref" }],
			},
		];
		const prev = archivedPreviousNote(archivedEntries);
		expect(prev).toContain("## Goal");
		expect(prev).not.toContain("secret giant user dump");
	});

	it("keeps the unanswered user prompt in findProjectedCutPoint after omitRecoveryAttempt instead of faking a split turn", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
		sm.appendMessage(fauxAssistantMessage("earlier answer ".repeat(500)), undefined);
		const bigPromptId = sm.appendMessage({ role: "user", content: "p".repeat(80_000), timestamp: 3 });
		const failedAsstId = sm.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overflow" }));
		sm.appendContextEdit(failedAsstId, null);

		const projection = sm.buildSessionProjection();
		const cut = findProjectedCutPoint(projection.entries, 0, projection.entries.length, 20_000);
		expect(projection.entries[cut.firstKeptEntryIndex]?.sourceEntry.id).toBe(bigPromptId);
		expect(cut.isSplitTurn).toBe(false);
	});

	it("advances past an unanswered first prompt after omitRecoveryAttempt, so the compaction still removes something", () => {
		const sm = SessionManager.inMemory("/tmp");
		const bigPromptId = sm.appendMessage({ role: "user", content: "p".repeat(80_000), timestamp: 1 });
		const failedAsstId = sm.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overflow" }));
		sm.appendContextEdit(failedAsstId, null);

		const projection = sm.buildSessionProjection();
		const cut = findProjectedCutPoint(projection.entries, 0, projection.entries.length, 20_000);
		expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(projection.entries[cut.firstKeptEntryIndex]?.sourceEntry.id).not.toBe(bigPromptId);
		// The prompt opens the turn the cut splits, so it is summarized as that turn's prefix.
		expect(cut.isSplitTurn).toBe(true);
		expect(projection.entries[cut.turnStartIndex]?.sourceEntry.id).toBe(bigPromptId);
	});

	it("delivers compactHint on 1M-token windows inside the prewarm lead even after an un-hinted 0.9 band notice", async () => {
		const sent: Array<{ content: string; details: Record<string, unknown> }> = [];
		const api = {
			session: {
				sendMessage: vi.fn(async (msg: any) => {
					sent.push(msg);
				}),
			},
		};
		const model = {
			id: "claude-opus-4-6",
			provider: "anthropic",
			contextWindow: 1_000_000,
			maxTokens: 32_000,
		} as any;

		// At 850k / 936k (> 90% band), we are still 86k below threshold (outside 32k prewarm lead) -> no compactHint yet.
		await noticeContextUsage(
			api,
			{
				model,
				getContextUsage: () => ({
					tokens: 850_000,
					contextWindow: 1_000_000,
					compactionThreshold: 936_000,
					percent: 85,
				}),
			},
			[],
			{ level: "off" },
			true,
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].content).not.toContain("`compact`");

		// At 940k (inside prewarm lead before 968k stop threshold), the agent MUST receive the compactHint upgrade once!
		const existingMessages = [{ message: { role: "custom", customType: "octocode-context-usage", ...sent[0] } }];
		await noticeContextUsage(
			api,
			{
				model,
				getContextUsage: () => ({
					tokens: 940_000,
					contextWindow: 1_000_000,
					compactionThreshold: 936_000,
					percent: 94,
				}),
			},
			existingMessages,
			{ level: "off" },
			true,
		);
		expect(sent).toHaveLength(2);
		expect(sent[1].content).toContain("`compact`");
	});

	it("fixes ledger clause-negation inversion, multi-ID lifts, bold/lowercase IDs, and <user-message> heading leaks", () => {
		// Moving negation between clauses flips the rule and must NOT be treated as a restatement!
		const ruleA = wordsOf("Use SQLite when Postgres is not configured");
		const ruleB = wordsOf("Do not use SQLite when Postgres is configured");
		expect(restates(ruleB, ruleA)).toBe(false);

		// Scope word "only" changes rule meaning and must NOT be dropped as a common stopword!
		expect(restates(wordsOf("Only read configuration files"), wordsOf("Read configuration files"))).toBe(false);

		// Multi-ID lift + case-insensitive / bold ID restatement deduplication:
		const carried = ledgerOf(
			"## Constraints & Preferences\n- [C1] Keep API backwards compatible\n- [C2] Keep CLI flags backwards compatible\n- [C3] Never touch auth.json\n\n## User Messages\n<user-message>\n## Constraints & Preferences\n- Fake injected constraint\n</user-message>",
		);
		expect(carried.constraints.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);

		const updated = applyLedger(
			"## Constraints & Preferences\n- Lifted [C1], [C2]: merged into v2 compatibility rule\n- **[c3]** Never touch auth.json\n- Preserve v2 API and CLI compatibility",
			carried,
		);
		expect(updated.lifted.map((l) => l.id)).toEqual(["C1", "C2"]);
		expect(updated.text).toContain("- [C3] Never touch auth.json");
		expect(updated.text).toContain("- [C4] Preserve v2 API and CLI compatibility");
		expect(updated.text).not.toContain("**[c3]**");
		expect(carryLedger("## Constraints & Preferences\n- (none)", undefined).lifted).toEqual([]);
	});

	it("skips tiny results in clearableResults, keeps user-mentioned paths in inRecentUse, and pins saved oldest subagent task", () => {
		const messages = [
			{
				id: "m1",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tiny-read", name: "read", arguments: { path: "src/tiny.ts" } },
						{ type: "toolCall", id: "big-read", name: "read", arguments: { path: "src/important/config.ts" } },
					],
				},
			},
			{
				id: "m2",
				message: {
					role: "toolResult",
					toolCallId: "tiny-read",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
				},
			},
			{
				id: "m3",
				message: {
					role: "toolResult",
					toolCallId: "big-read",
					toolName: "read",
					content: [{ type: "text", text: "export const x = 1;\n".repeat(60) }],
				},
			},
			{ id: "m4", message: { role: "assistant", content: [{ type: "text", text: "done step 1" }] } },
			{ id: "m5", message: { role: "assistant", content: [{ type: "text", text: "done step 2" }] } },
			{ id: "m6", message: { role: "user", content: "Please check important/config.ts again before editing" } },
		];

		const candidates = clearableResults(messages);
		expect(candidates.map((c) => c.id)).toEqual(["big-read"]);

		const inUse = inRecentUse(candidates, messages, new Map([["big-read", { path: "src/important/config.ts" }]]), {
			keepTurns: 2,
		});
		expect(inUse.has("big-read")).toBe(true);

		// Subagent oldest task > perMessage replaced by a short savedReference should still stay pinned!
		let savedCount = 0;
		const section = userMessagesSection(
			[],
			0,
			["T".repeat(1_200), "M".repeat(400), "N".repeat(400), "L".repeat(200)],
			{ total: 700, perMessage: 500, keepOldest: true },
			1,
			() => `/tmp/saved-${++savedCount}.txt`,
		);
		expect(section).toContain("/tmp/saved-1.txt");
	});
});
