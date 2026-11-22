import { describe, expect, it } from "vitest";
import {
	CATALOG,
	EVENT_KINDS,
	EXPLICIT_EVENTS,
	describeEvent,
	parseEventKind,
} from "../../../src/octocode/wake/catalog.ts";
import { HOOK_LIFECYCLE_EVENTS, hookTopic } from "../../../src/octocode/events/hook-lifecycle.ts";

describe("the agent event catalog", () => {
	it("gives every kind a label and a dedupe key, and lists the closed set", () => {
		const lifecycle = HOOK_LIFECYCLE_EVENTS.map(hookTopic);
		expect(EVENT_KINDS).toHaveLength(19 + lifecycle.length);
		expect(EVENT_KINDS).toEqual(expect.arrayContaining(lifecycle));
		expect(EVENT_KINDS).toEqual(expect.arrayContaining(["ticket.resolved", "ticket.rejected"]));
		for (const kind of EVENT_KINDS) {
			expect(typeof CATALOG[kind].label).toBe("function");
			expect(typeof CATALOG[kind].key).toBe("function");
		}
		expect([...EXPLICIT_EVENTS].sort()).toEqual(
			[
				"agent.ended",
				"check.result",
				"item.changed",
				"item.state",
				"machine.load",
				"path.unlocked",
				"peer.landed",
				"time.due",
			].sort(),
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
		// A hook run is the loop's own record: no wait can name it.
		expect(() => parseEventKind(hookTopic(HOOK_LIFECYCLE_EVENTS[0]))).toThrow(/No event/);
	});
});
