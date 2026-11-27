import { describe, expect, it } from "vitest";
import { finalizeCompactionResult } from "../src/core/compaction/checkpoint.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const branch: SessionEntry[] = [
	{
		type: "message",
		id: "kept",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "user",
			content: "Do not lose this request",
			timestamp: 0,
		},
	},
];

describe("compaction boundary validation", () => {
	it.each([8000, 0])("rejects a missing retained boundary even with context window %s", (contextWindow) => {
		expect(() =>
			finalizeCompactionResult(
				{
					summary: "Summary",
					firstKeptEntryId: "another-branch-entry",
					tokensBefore: 9000,
				},
				{ branchEntries: branch, contextWindow, reserveTokens: 1000 },
			),
		).toThrow(/retained.*boundary/i);
	});

	it("accepts the retained boundary from the active branch", () => {
		const result = {
			summary: "Summary",
			firstKeptEntryId: "kept",
			tokensBefore: 9000,
		};
		expect(
			finalizeCompactionResult(result, {
				branchEntries: branch,
				contextWindow: 8000,
				reserveTokens: 1000,
			}),
		).toBe(result);
	});
});

it.each(["manual", "threshold", "overflow"] as const)(
	"preserves history when %s compaction supplies a foreign boundary",
	async (reason) => {
		const { fauxAssistantMessage } = await import("@octocodeai/octocode-ai");
		const { SessionManager } = await import("../src/core/session-manager.ts");
		const { createHarness } = await import("./suite/harness.ts");
		const manager = SessionManager.inMemory();
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "small", contextWindow: 8000 }],
			tools: [],
			compactionPolicy: { keepRecentTokens: 1 },
			builtinCompactionFactories: [
				(api) => {
					api.bus.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Checkpoint",
							firstKeptEntryId: "foreign-entry",
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		try {
			manager.appendMessage({
				role: "user",
				content: "Keep this instruction",
				timestamp: 0,
			});
			manager.appendMessage(fauxAssistantMessage("Answer"));
			harness.session.refreshContext();
			const before = manager.getBranch();
			const projection = manager.buildSessionProjection();
			if (reason === "manual") await expect(harness.session.compact()).rejects.toThrow(/retained.*boundary/i);
			else
				expect(
					await (
						harness.session as unknown as {
							_runAutoCompaction(reason: "threshold" | "overflow", retry: boolean): Promise<boolean>;
						}
					)._runAutoCompaction(reason, reason === "overflow"),
				).toBe(false);
			expect(manager.getBranch()).toEqual(before);
			expect(manager.buildSessionProjection()).toEqual(projection);
		} finally {
			harness.cleanup();
		}
	},
);
