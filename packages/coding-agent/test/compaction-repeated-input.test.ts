import type { StreamFn } from "@octocodeai/octocode-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { compact, prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "summary-test",
	name: "Summary Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

it("sends only the newest checkpoint once when many old compaction entries lie inside the retained range", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "STABLE-POLICY-AND-TOOLS", timestamp: 0 });
	const first = manager.appendMessage({ role: "user", content: "FOUNDATIONAL-REQUEST", timestamp: 1 });
	for (let cycle = 1; cycle <= 40; cycle++) {
		manager.appendMessage({ role: "user", content: `Request ${cycle}`, timestamp: cycle });
		manager.appendMessage(fauxAssistantMessage(`Answer ${cycle}`));
		// An imported or manually chosen boundary can keep older compaction IDs in the raw range.
		manager.appendCompaction(`checkpoint[${cycle}]`, first, 10_000);
	}
	manager.appendMessage({ role: "user", content: "LATEST-REQUEST", timestamp: 100 });
	manager.appendMessage(fauxAssistantMessage("LATEST-ANSWER"));
	const before = manager.buildSessionProjection();
	expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(40);
	expect(before.messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
	const prepared = prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 });
	if (!prepared) throw new Error("Expected compactable history");
	expect(prepared.previousSummary).toBe("checkpoint[40]");
	expect(
		[...prepared.messagesToSummarize, ...prepared.turnPrefixMessages].some(
			(message) => message.role === "compactionSummary" || message.role === "system",
		),
	).toBe(false);
	const prompts: string[] = [];
	const streamFn: StreamFn = (_model, context) => {
		prompts.push(JSON.stringify(context.messages));
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Next checkpoint") }),
		);
		return stream;
	};
	await compact(prepared, model, undefined, undefined, undefined, undefined, undefined, streamFn);
	const prompt = prompts.join("\n");
	expect(prompt.split("checkpoint[40]")).toHaveLength(2);
	for (let cycle = 1; cycle < 40; cycle++) expect(prompt).not.toContain(`checkpoint[${cycle}]`);
	expect(prompt).not.toContain("STABLE-POLICY-AND-TOOLS");
	expect(prompt).toContain("LATEST-REQUEST");
	expect(manager.buildSessionProjection()).toEqual(before);
});
