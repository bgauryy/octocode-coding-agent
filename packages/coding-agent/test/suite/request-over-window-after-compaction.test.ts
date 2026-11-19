import { type AssistantMessage, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function usage(input: number) {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * After a switch to a smaller model, a compaction that cannot shrink the context left the next request at three times
 * the window, which the provider can only refuse. When the compaction for a request finds nothing it keeps can fit and
 * the request is still larger than the whole window, it is not sent: the run ends with what the user can do.
 */
describe("a request still over the window after compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is not sent, and the run ends with an actionable error", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-small", contextWindow: 1_000, maxTokens: 100 }],
			compactionPolicy: { keepRecentTokens: 1, reserveTokens: 100 },
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier prompt" }],
			timestamp: now - 1000,
		});
		const previous: AssistantMessage = {
			...fauxAssistantMessage("earlier answer", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(900),
		};
		harness.sessionManager.appendMessage(previous);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		// The compaction before the prompt summarizes the earlier turn; the prompt's own request must not follow.
		harness.setResponses([
			fauxAssistantMessage("summary of the earlier turn"),
			fauxAssistantMessage("summary of the failed turn"),
			fauxAssistantMessage("must not be requested"),
		]);

		// The newest turn alone is about 3,000 tokens: no kept tail can fit, so the compaction fails before summarizing.
		await harness.session.prompt(`next prompt ${"x".repeat(9_000)}`);

		// The prompt's own request is never sent; the only later request summarizes the turn that failed, so the next
		// prompt starts from room instead of from a context the window cannot hold.
		expect(harness.faux.state.callCount).toBe(2);
		const last = harness.session.agent.state.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/more than faux-small's 1,000-token window/);
		expect(last.errorMessage).toMatch(/start a new session with \/new/);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.find((end) => end.errorMessage)?.errorMessage).toMatch(/leaves no room for a summary/);
		expect(ends.at(-1)?.result?.summary).toBe("summary of the failed turn");
	});
});
