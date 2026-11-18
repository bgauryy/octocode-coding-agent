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
		expect(error).toMatchObject({
			message: expect.stringMatching(/recent history is about 0 tokens, below the [\d,]+-token budget/),
			notice: expect.stringMatching(/^Nothing to compact yet: .*below the [\d,]+-token budget/),
		});
		expect((error as Error).message).not.toMatch(/too small/);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toEqual([]);
		expect(failed).toEqual([]);
		expect(harness.session.isCompacting).toBe(false);
	});
});
