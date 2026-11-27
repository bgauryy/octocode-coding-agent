import { type AssistantMessage, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const usage = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * On a small window, prompts whose own turn fills it cannot be compacted around. Three such failures turn automatic
 * compaction off; a normal prompt after them must still be answered.
 */
describe("repeated prompts that alone fill a small window", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("leave the session able to answer a normal prompt afterwards", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: 16_000, maxTokens: 1_000 }],
			compactionPolicy: { keepRecentTokens: 1, reserveTokens: 1_000 },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier" }],
			timestamp: now - 1000,
		});
		const previous: AssistantMessage = {
			...fauxAssistantMessage("earlier answer", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(3_000),
		};
		harness.sessionManager.appendMessage(previous);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("a short answer")));

		for (let turn = 0; turn < 4; turn++) await harness.session.prompt(`big ${turn} ${"x".repeat(60_000)}`);
		await harness.session.prompt("a normal short prompt");

		const last = harness.session.agent.state.messages.at(-1) as AssistantMessage;
		expect(last.errorMessage).toBeUndefined();
		expect(last.stopReason).toBe("stop");
		// The failed turns are covered by a summary, not dropped without a trace.
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
	});
});
