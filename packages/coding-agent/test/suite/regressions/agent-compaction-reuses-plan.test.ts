import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { afterEach, expect, it } from "vitest";
import type { CompactionPreparation } from "../../../src/core/compaction/index.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/features/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * The agent's own compaction (its `compact` tool, at a task boundary) runs the plan made ahead of the threshold, so the
 * summary already requested for that plan can be used instead of paying for another; the user's `/compact` cuts afresh.
 */

const filler = (tokens: number, label: string) => `${label} ${"x".repeat(Math.ceil(tokens * CHARS_PER_TOKEN))}`;

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

async function plannedSession() {
	const manager = SessionManager.inMemory();
	const planned: CompactionPreparation[] = [];
	const compacted: SessionBeforeCompactEvent[] = [];
	const aborted: boolean[] = [];
	harness = await createHarness({
		sessionManager: manager,
		models: [{ id: "window-200k", contextWindow: 200_000 }],
		tools: [],
		compactionPolicy: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_compact_prewarm", async (event) => {
					planned.push(event.preparation);
					event.signal.addEventListener("abort", () => aborted.push(true));
				});
				api.bus.on("session_before_compact", async (event) => {
					compacted.push(event);
					return {
						compaction: {
							summary: "Checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	// Inside the prewarm lead (the loop stops at 180,000 tokens, 90% of the window; lead 20,000), below that stop.
	for (let i = 0; i < 6; i++) {
		manager.appendMessage({ role: "user", content: filler(28_000, `more ${i}`), timestamp: 0 });
		manager.appendMessage(fauxAssistantMessage(`answer more ${i}`));
	}
	harness.session.refreshContext();
	harness.setResponses([fauxAssistantMessage("near the threshold")]);
	await harness.session.prompt("work");
	expect(planned).toHaveLength(1);
	expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	return { harness, planned, compacted, aborted };
}

it("runs the plan made ahead of the threshold for the agent's own compaction, labelled as the agent's", async () => {
	const { harness: session, planned, compacted } = await plannedSession();
	const result = await session.session.compact({ customInstructions: "next: the parser tests", requestedBy: "agent" });
	expect(compacted).toHaveLength(1);
	expect(compacted[0].preparation).toBe(planned[0]);
	expect(compacted[0]).toMatchObject({ reason: "manual", requestedBy: "agent" });
	expect(result.details).toMatchObject({
		trigger: "agent",
		focus: { source: "agent", chars: "next: the parser tests".length, sha256: expect.any(String) },
	});
});

it("cuts afresh for the user's /compact, ending the plan made ahead", async () => {
	const { harness: session, planned, compacted, aborted } = await plannedSession();
	const result = await session.session.compact({ customInstructions: "keep the release notes" });
	expect(compacted).toHaveLength(1);
	expect(compacted[0].preparation).not.toBe(planned[0]);
	expect(compacted[0]).toMatchObject({ reason: "manual", requestedBy: "user" });
	expect(aborted).toEqual([true]);
	expect(result.details).toMatchObject({ trigger: "user", focus: { source: "user" } });
	// The focus itself is never stored, only its length and hash.
	expect(JSON.stringify(result.details)).not.toContain("keep the release notes");
});
