import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/**
 * A 10,000-token window with a 1,000-token reserve (threshold 9,000), a turn of 10,000 characters and a prompt of
 * 15,000 with no provider count: about 10,000 tokens at Claude's 2.5 characters per token (the ratio of a model of no
 * known family), about 7,150 at GPT's 3.5.
 */
async function promptOn(modelId: string): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: modelId, contextWindow: 10_000, maxTokens: 100 }],
		tools: [],
		compactionPolicy: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: `earlier ${"a".repeat(10_000)}` }],
		timestamp: now - 2000,
	});
	// No provider count: the reply reported no usage, so the trigger estimates the whole context.
	harness.sessionManager.appendMessage({ ...fauxAssistantMessage("earlier answer", { timestamp: now - 1000 }) });
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	harness.setResponses([fauxAssistantMessage("answered")]);
	await harness.session.prompt(`prompt ${"b".repeat(15_000)}`);
	return harness;
}

describe("the compaction trigger counts at the model's tokenizer ratio", () => {
	it("does not compact a GPT session that Claude's denser ratio would put over the threshold", async () => {
		const harness = await promptOn("gpt-6.1-sol");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("compacts the same context for a model of no known family", async () => {
		const harness = await promptOn("faux-1");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
	});
});
