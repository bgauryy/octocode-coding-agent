import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionCompactFailedEvent } from "../../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("overflow recovery with nothing to compact", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports that recovery failed instead of giving up silently after hiding the failed attempt", async () => {
		const failed: SessionCompactFailedEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_compact_failed", async (event) => {
						failed.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		// The only message is the oversized prompt: once the failed response is omitted, no span can be summarized.
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
			}),
		]);

		await harness.session.prompt("one oversized prompt");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "overflow",
				aborted: false,
				willRetry: false,
				errorMessage: expect.stringMatching(/^Context overflow recovery failed/),
			}),
		]);
		expect(failed).toEqual([
			expect.objectContaining({
				reason: "overflow",
				aborted: false,
				willRetry: false,
				fromExtension: false,
				errorMessage: expect.stringMatching(/^Context overflow recovery failed/),
			}),
		]);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
