import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Found by the session replay (`e2e-replay.test.ts` on `large-session.jsonl` at a 64k window): a threshold compaction in
 * the middle of a run summarized the tool result the model had just asked for, and the run went on with only the
 * checkpoint (a 49k-character `read` result against a 16k-token tail). When the newest tool result alone is larger than
 * the kept tail (`keepRecentTokens`: 20k tokens by default, a quarter of a small window, less after the window fit), the
 * cut lands on the first cut point after that result. With nothing after it, that is the
 * assistant's call (call and result are kept); with a session notice after it (`octocode-context-usage`, written once a
 * result is in), the cut lands on the notice and the call and its result are summarized away.
 */

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A prompt, an earlier exchange, then a call whose 48k-character result has just come in; a notice after it when asked. */
function branch(notice: boolean, nextPrompt?: string) {
	const manager = SessionManager.inMemory("/workspace/project");
	const at = 1_700_000_000_000;
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Port the selector." }], timestamp: at });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `Earlier work. ${"e".repeat(8_000)}` }],
		api: "x",
		provider: "p",
		model: "m",
		usage,
		stopReason: "stop",
		timestamp: at + 1,
	} as never);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Read the renderer." }], timestamp: at + 2 });
	const callId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/renderer.ts" } }],
		api: "x",
		provider: "p",
		model: "m",
		usage,
		stopReason: "toolUse",
		timestamp: at + 3,
	} as never);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "r".repeat(48_000) }],
		isError: false,
		timestamp: at + 4,
	});
	if (notice) manager.appendCustomMessageEntry("octocode-context-usage", "Context: 62% of the window.", false);
	if (nextPrompt)
		manager.appendMessage({ role: "user", content: [{ type: "text", text: nextPrompt }], timestamp: at + 5 });
	return { entries: manager.getBranch(), callId };
}

/** A tail smaller than the newest result. */
const settings = { enabled: true, reserveTokens: 8_000, keepRecentTokens: 2_000 };

describe("a compaction whose kept tail is smaller than the newest tool result", () => {
	it("keeps the call and its result when nothing follows the result", () => {
		const { entries, callId } = branch(false);
		expect(prepareCompaction(entries, settings)?.firstKeptEntryId).toBe(callId);
	});

	// Found by the replay harness: a notice after the result moved the cut past it (fixed in `cut-point.ts`).
	it("keeps the call and its result when a session notice follows the result", () => {
		const { entries, callId } = branch(true);
		const kept = prepareCompaction(entries, settings)!.firstKeptEntryId;
		const order = entries.map((entry) => entry.id);
		expect(order.indexOf(kept)).toBeLessThanOrEqual(order.indexOf(callId));
	});

	it("still moves past an older large exchange once a user message follows it", () => {
		const { entries, callId } = branch(true, "Now write the tests.");
		const kept = prepareCompaction(entries, settings)!.firstKeptEntryId;
		const order = entries.map((entry) => entry.id);
		expect(order.indexOf(kept)).toBeGreaterThan(order.indexOf(callId));
	});
});
