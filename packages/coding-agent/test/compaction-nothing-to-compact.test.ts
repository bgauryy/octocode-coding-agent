import { describe, expect, it } from "vitest";
import { explainNothingToCompact } from "../src/core/compaction/nothing-to-compact.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function sessionWith(texts: string[]) {
	const manager = SessionManager.inMemory();
	for (const text of texts) {
		manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	return manager.getBranch();
}

describe("explainNothingToCompact", () => {
	it("says recent history is below the kept-recent budget, with both numbers, not that the session is small", () => {
		const { message, notice } = explainNothingToCompact(sessionWith(["x".repeat(4_000)]), 20_000);
		expect(message).toMatch(/about 1,\d{3} tokens/);
		expect(message).toContain("20,000-token budget");
		expect(message).not.toMatch(/too small/);
		expect(notice).toMatch(/^Nothing to compact yet: /);
	});

	it("names the other cause when history exceeds the budget but no earlier turn can be summarized", () => {
		const { message } = explainNothingToCompact(sessionWith(["x".repeat(4_000)]), 100);
		expect(message).toMatch(/no complete earlier turn/);
	});
});
