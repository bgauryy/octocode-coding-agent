import { describe, expect, it } from "vitest";
import { wakeGateOf } from "../../src/octocode/wake/gate.ts";
import { fakeHost } from "./fake-host.ts";

describe("wake gate dropped nudges", () => {
	it("reads without draining until the announcer acknowledges", () => {
		const gate = wakeGateOf(fakeHost().api);
		gate.drop(3);
		for (let render = 0; render < 5; render++) expect(gate.droppedCount()).toBe(3);
		gate.ackDropped(3);
		expect(gate.droppedCount()).toBe(0);
	});

	it("keeps nudges dropped after the count that was announced", () => {
		const gate = wakeGateOf(fakeHost().api);
		gate.drop(3);
		const seen = gate.droppedCount();
		gate.drop();
		gate.ackDropped(seen);
		expect(gate.droppedCount()).toBe(1);
	});
});
