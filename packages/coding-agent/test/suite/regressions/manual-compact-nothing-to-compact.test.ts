import { afterEach, describe, expect, it } from "vitest";
import { NothingToCompactError } from "../../../src/core/agent-session/compaction-control.ts";
import type { SessionCompactFailedEvent } from "../../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("manual compaction with nothing to compact", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rejects with a typed no-op, keeping the SDK message, and emits no compaction or failure event", async () => {
		const failed: SessionCompactFailedEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(api) => {
					api.on("session_compact_failed", async (event) => {
						failed.push(event);
					});
				},
			],
		});
		harnesses.push(harness);

		const error = await harness.session.compact().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(NothingToCompactError);
		expect(error).toMatchObject({
			message: "Nothing to compact (session too small)",
			notice: "Nothing to compact yet",
		});
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toEqual([]);
		expect(failed).toEqual([]);
		expect(harness.session.isCompacting).toBe(false);
	});
});
