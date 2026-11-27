import { type AssistantMessage, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

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
 * Octocode's thrash breaker refuses an automatic compaction with `{ cancel: true, failure }` while the context still
 * fits the window (`octocode/compaction/register.ts`). Before a prompt, that refusal must surface as the compaction's
 * error and still send the prompt; aborting the run there dropped it.
 */
describe("pre-prompt compaction refused as a failure", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports the refusal and still sends the prompt", async () => {
		const refusal = "Automatic compaction stopped: refused";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 100 }],
			compactionPolicy: { keepRecentTokens: 1, reserveTokens: 100 },
			builtinCompactionFactories: [
				(api) => {
					api.bus.on("session_before_compact", async () => ({ cancel: true, failure: refusal }));
				},
			],
		});
		harnesses.push(harness);

		// Above the threshold (window less reserve), still within the window.
		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const previous: AssistantMessage = {
			...fauxAssistantMessage("previous answer", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(950),
		};
		harness.sessionManager.appendMessage(previous);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("answered")]);

		await harness.session.prompt("next prompt");

		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			aborted: false,
			errorMessage: expect.stringContaining(refusal),
		});
		expect(getUserTexts(harness)).toContain("next prompt");
		expect(harness.faux.state.callCount).toBe(1);
	});
});
