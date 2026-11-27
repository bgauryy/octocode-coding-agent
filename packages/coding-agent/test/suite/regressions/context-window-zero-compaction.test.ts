import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionSettings, shouldCompact } from "../../../src/core/compaction/index.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

/** A model whose context window resolves to 0 (unknown, e.g. a virtual model without a configured window). */
describe("automatic compaction with an unknown (zero) context window", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("has no threshold to cross", () => {
		const settings: CompactionSettings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
		expect(shouldCompact(1, 0, settings)).toBe(false);
		expect(shouldCompact(1_000_000, -1, settings)).toBe(false);
	});

	it("does not compact after every run and before every prompt", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 0, maxTokens: 100 }],
			compactionPolicy: { keepRecentTokens: 1 },
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
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);

		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["first prompt", "second prompt"]);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
