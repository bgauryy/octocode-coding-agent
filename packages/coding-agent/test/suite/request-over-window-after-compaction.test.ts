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
			fauxAssistantMessage("must not be requested"),
		]);

		// The newest turn alone is about 3,000 tokens: no kept tail can fit, so the compaction fails before summarizing.
		await harness.session.prompt(`next prompt ${"x".repeat(9_000)}`);

		expect(harness.faux.state.callCount).toBe(1);
		const last = harness.session.agent.state.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/more than faux-small's 1,000-token window/);
		expect(last.errorMessage).toMatch(/start a new session with \/new/);
		const failed = harness.eventsOfType("compaction_end").at(-1);
		expect(failed?.errorMessage).toMatch(/leaves no room for a summary/);
	});
});
