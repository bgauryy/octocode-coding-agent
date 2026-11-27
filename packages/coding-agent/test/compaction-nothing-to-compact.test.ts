import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../src/core/compaction/compaction.ts";
import { explainNothingToCompact } from "../src/core/compaction/nothing-to-compact.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function sessionWith(texts: string[]) {
	const manager = SessionManager.inMemory();
	for (const text of texts) {
		manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	return manager.getBranch();
}

const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
/** A system message of `chars` characters (2.5 per token): the leading one is the prompt, a later one an update. */
const system = (manager: SessionManager, chars: number, timestamp: number) =>
	manager.appendMessage({ role: "system", content: "s".repeat(chars), timestamp } as never);
const user = (manager: SessionManager, text: string, timestamp: number) =>
	manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp });

describe("explainNothingToCompact", () => {
	it("says recent history is below the kept-recent budget, with both numbers, not that the session is small", () => {
		const { message, notice } = explainNothingToCompact(sessionWith(["x".repeat(4_000)]), 20_000);
		expect(message).toMatch(/about 1,\d{3} tokens/);
		expect(message).toContain("20,000-token budget");
		expect(message).not.toMatch(/too small/);
		expect(notice).toMatch(/^Nothing to compact yet: /);
	});

	it("says an empty session has no messages, not that zero tokens fit in the budget", () => {
		const { message, notice } = explainNothingToCompact(sessionWith([]), 20_000);
		expect(message).toBe("Nothing to compact: the session has no messages yet");
		expect(notice).toBe("Nothing to compact yet: the session has no messages yet");
	});

	it("names the other cause when history exceeds the budget but no earlier turn can be summarized", () => {
		const { message } = explainNothingToCompact(sessionWith(["x".repeat(4_000)]), 100);
		expect(message).toMatch(/no complete earlier turn/);
	});

	// Contract change: the recent-messages budget counts the conversation only. The system prompt and its updates are
	// never summarized (the compaction entry replays them), so counting them let a prompt update push a 12-token
	// conversation out of the kept tail.
	it("counts what compaction counts: the conversation, not the system prompt the session records", () => {
		// A real session: its system prompt (48,000 tokens) is the first entry, then a 154-token conversation.
		const manager = SessionManager.inMemory();
		system(manager, 120_000, 0);
		user(manager, "x".repeat(200), 1);
		user(manager, "y".repeat(184), 2);
		expect(prepareCompaction(manager.getBranch(), settings)).toBeUndefined();
		const { message } = explainNothingToCompact(manager.getBranch(), 20_000);
		expect(message).toBe(
			"Nothing to compact: the conversation is about 154 tokens, within the 20,000-token budget compaction keeps as recent messages (the system prompt and tools do not count toward it)",
		);
	});

	it("keeps a small conversation whole across a prompt update", () => {
		const manager = SessionManager.inMemory();
		system(manager, 120_000, 0);
		user(manager, "hi there", 1);
		system(manager, 120_000, 2);
		user(manager, "and now?", 3);
		expect(prepareCompaction(manager.getBranch(), settings)).toBeUndefined();
		expect(explainNothingToCompact(manager.getBranch(), 20_000).message).toMatch(
			/^Nothing to compact: the conversation is about \d+ tokens, within the 20,000-token budget/,
		);
	});
});

describe("the recent-messages budget", () => {
	it("keeps the newest keepRecentTokens of conversation, a prompt update in it counting nothing", () => {
		const manager = SessionManager.inMemory();
		system(manager, 120_000, 0);
		user(manager, "a".repeat(25_000), 1);
		const second = user(manager, "b".repeat(25_000), 2);
		system(manager, 120_000, 3);
		user(manager, "c".repeat(25_000), 4);
		// 10,000 + 10,000 conversation tokens reach the 20,000 budget at the second turn; the update between does not.
		const preparation = prepareCompaction(manager.getBranch(), settings);
		expect(preparation?.firstKeptEntryId).toBe(second);
		expect(preparation?.messagesToSummarize).toEqual([
			{ role: "user", content: [{ type: "text", text: "a".repeat(25_000) }], timestamp: 1 },
		]);
	});
});
