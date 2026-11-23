import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { NothingToCompactError } from "../../../src/core/agent-session/compaction-control.ts";
import type { SessionCompactFailedEvent } from "../../../src/core/features/index.ts";
import { createHarness, type Harness } from "../harness.ts";
import { testFeatures } from "../../helpers/features.ts";

describe("manual compaction with nothing to compact", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rejects with a typed no-op, keeping the SDK message, and emits no compaction or failure event", async () => {
		const failed: SessionCompactFailedEvent[] = [];
		const harness = await createHarness({
			features: testFeatures([
				(api) => {
					api.bus.on("session_compact_failed", async (event) => {
						failed.push(event);
					});
				},
			]),
		});
		harnesses.push(harness);

		const error = await harness.session.compact().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(NothingToCompactError);
		// Contract change: the words state the condition the cut applies. An empty session has no messages, so it says
		// that rather than a token count against the kept budget.
		expect(error).toMatchObject({
			message: "Nothing to compact: the session has no messages yet",
			notice: "Nothing to compact yet: the session has no messages yet",
		});
		expect((error as Error).message).not.toMatch(/too small/);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toEqual([]);
		expect(failed).toEqual([]);
		expect(harness.session.isCompacting).toBe(false);
	});

	// A prompt update counted toward the recent-messages budget: one larger than it pushed every earlier turn of a
	// two-prompt conversation out of the kept tail, so `/compact` summarized a few words.
	it("keeps a small conversation whole when the system prompt changed between its turns", async () => {
		let run = 0;
		const harness = await createHarness({
			features: testFeatures([
				(api) => {
					api.bus.on("before_agent_start", async (event) => {
						run++;
						// About 24,000 tokens, past the 20,000-token budget on its own.
						event.systemPromptOptions.sections.rules = `<rules>${String(run).repeat(60_000)}</rules>`;
					});
				},
			]),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const recorded = harness.sessionManager.getBranch().filter((entry) => entry.type === "message");
		expect(recorded.map((entry) => entry.message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"system",
			"user",
			"assistant",
		]);

		const error = await harness.session.compact().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(NothingToCompactError);
		expect((error as Error).message).toMatch(
			/^Nothing to compact: the conversation is about \d+ tokens, within the 20,000-token budget compaction keeps as recent messages \(the system prompt and tools do not count toward it\)$/,
		);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
	});
});
