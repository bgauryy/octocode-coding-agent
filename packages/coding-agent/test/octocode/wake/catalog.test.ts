import { describe, expect, it } from "vitest";
import {
	CATALOG,
	EVENT_KINDS,
	EXPLICIT_EVENTS,
	describeEvent,
	parseEventKind,
} from "../../../src/octocode/wake/catalog.ts";

describe("the agent event catalog", () => {
	it("gives every kind a label and a dedupe key, and lists the closed set", () => {
		expect(EVENT_KINDS).toHaveLength(16);
		for (const kind of EVENT_KINDS) {
			expect(typeof CATALOG[kind].label).toBe("function");
			expect(typeof CATALOG[kind].key).toBe("function");
		}
		expect([...EXPLICIT_EVENTS].sort()).toEqual(
			["agent.ended", "check.result", "item.changed", "item.state", "path.unlocked", "peer.landed", "time.due"].sort(),
		);
	});

	it("renders the row label and key of an event", () => {
		expect(
			describeEvent({
				kind: "agent.report",
				agent: "jolly-reef",
				role: "implementer",
				outcome: "done",
				item: "B526",
				reportId: "r1",
			}),
		).toEqual({ label: "report jolly-reef done (B526)", key: "report:r1" });
		expect(describeEvent({ kind: "item.state", ref: "B7", state: "done" })).toEqual({
			label: "B7 is done",
			key: "item:B7:done",
		});
		expect(describeEvent({ kind: "job.exit", job: "bash-5", exit: 0, durationMs: 12_000, startedAt: 9 }).label).toBe(
			"job bash-5 exit 0 · 12s",
		);
		expect(describeEvent({ kind: "item.ready", ref: "B12", prerequisites: [] }).label).toBe("B12 ready");
		expect(describeEvent({ kind: "item.ready", ref: "B12", prerequisites: ["B3", "B4"] }).label).toBe(
			"B12 ready: B3, B4 done",
		);
	});

	it("refuses an unknown kind, naming the choices", () => {
		expect(parseEventKind("item.state")).toBe("item.state");
		expect(() => parseEventKind("nope")).toThrow(/No event "nope": the choices are agent\.report/);
	});
});
