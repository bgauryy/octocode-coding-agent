import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { computeSessionStats } from "../../src/core/session-stats.ts";
import { formatSessionReport } from "../../src/octocode/shared/session-report.ts";

const reply = (cost: number): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "m",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	},
	stopReason: "stop",
	timestamp: 1,
});
const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

describe("/session $/turn after a branch", () => {
	it("lists only the turns of the current branch, while totals keep the abandoned one", () => {
		const manager = SessionManager.inMemory("/tmp/p");
		manager.appendMessage(user("one"));
		const firstReply = manager.appendMessage(reply(0.1));
		manager.appendMessage(user("abandoned"));
		manager.appendMessage(reply(5));
		// Back to the first reply: the abandoned turn is no longer on the branch.
		manager.branch(firstReply);
		manager.appendMessage(user("kept"));
		manager.appendMessage(reply(0.3));

		const text = formatSessionReport({
			stats: computeSessionStats(manager, { sessionFile: undefined, sessionId: "s" }),
			entries: manager.getEntries(),
			branch: manager.getBranch(),
			prices: { getModel: () => undefined },
			selectedModelKey: "x/y",
		});
		expect(text).toContain("Turn 1: ≈$0.1000");
		expect(text).toContain("Turn 2: ≈$0.3000");
		expect(text).not.toContain("Turn 3");
		expect(text).not.toContain("$5.0000");
	});
});
