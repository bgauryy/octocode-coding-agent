import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";
import { blockingTool, createRig, wakeGateOf, type Rig } from "../loop-characterization/rig.ts";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { ShadowLoop, type ShadowDiff } from "../../../src/octocode/events/loop/shadow.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import { wakeCatalog } from "../../../src/octocode/wake/loop-catalog.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});
async function rig(eventLoop?: "old" | "shadow") {
	const made = await createRig(eventLoop ? { settings: { runtime: { eventLoop } } } : {});
	rigs.push(made);
	return made;
}

const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });
const message = (text: string) => ({ customType: "loop-test", content: text, display: true });
const wake = { triggerTurn: true, deliverAs: "followUp" as const, together: true };

describe("the runtime.eventLoop switch", () => {
	it("attaches nothing when off, which is the default", async () => {
		const r = await rig();
		expect(r.shadow()).toBeUndefined();
	});

	it("attaches nothing when set to old", async () => {
		const r = await rig("old");
		expect(r.shadow()).toBeUndefined();
	});

	it("runs the shadow loop beside the gate when set to shadow, and the session behaves as it does with the loop off", async () => {
		const r = await rig("shadow");
		expect(r.shadow()).toBeDefined();
		r.harness.setResponses([r.reply("woken")]);
		await wakeGateOf(r.api).emit(exit("bash-1"), message("WAKE-A"), wake);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(r.shadow()?.stats()).toEqual({ emits: 1, gateTurns: 1, loopTurns: 1 });
		expect(r.shadow()?.end()).toEqual([]);
	});

	it("merges wakes sent together into one loop turn while the gate (unchanged) runs two", async () => {
		const r = await rig("shadow");
		r.harness.setResponses([r.reply("first"), r.reply("second")]);
		const gate = wakeGateOf(r.api);
		await Promise.all([
			gate.emit(exit("bash-1"), message("WAKE-A"), wake),
			gate.emit(exit("bash-2"), message("WAKE-B"), wake),
		]);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(2);
		const stats = r.shadow()?.stats();
		expect(stats?.gateTurns).toBe(2);
		expect(stats?.loopTurns).toBe(1);
		// merging two wakes into one turn is the intended difference, not a lost wake
		expect(r.shadow()?.end()).toEqual([]);
	});

	it("never starts a turn by itself", async () => {
		const r = await rig("shadow");
		r.harness.setResponses([r.reply("unused")]);
		await wakeGateOf(r.api).emit(exit("bash-1"), message("QUIET"), { triggerTurn: false, deliverAs: "followUp" });
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(0);
	});

	it("follows a run: a follow-up wake sent mid-run is delivered by the loop when the run settles", async () => {
		const slow = blockingTool();
		const r = await createRig({ tools: [slow.tool], settings: { runtime: { eventLoop: "shadow" } } });
		rigs.push(r);
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("first answer"),
			r.reply("answer to the wake"),
		]);
		const running = r.harness.session.prompt("go");
		await slow.started;
		await wakeGateOf(r.api).emit(exit("bash-1"), message("WAKE-FOLLOW"), wake);
		slow.release();
		await running;
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(2);
		expect(r.shadow()?.stats().loopTurns).toBe(1);
		expect(r.shadow()?.end()).toEqual([]);
	});
});

describe("the shadow comparison", () => {
	const source = makeSource("child", "a", "in-process", "proven");
	const event = (job: string): PayloadEvent => exit(job);
	const shadow = () => {
		const reported: ShadowDiff[] = [];
		return {
			loop: new ShadowLoop({
				catalog: wakeCatalog,
				windowMs: () => 0,
				report: (diff) => void reported.push(diff),
				failed: (error) => {
					throw error;
				},
			}),
			reported,
		};
	};

	it("reports a wake the gate sent that the loop never delivered", () => {
		const { loop, reported } = shadow();
		// the loop was never told of the event (no source), but the gate sent it with a turn
		const ticket = loop.emitted([event("j1")], [], true, false);
		loop.sent(ticket, true);
		loop.end();
		expect(reported.map((diff) => diff.kind)).toEqual(["wake-lost"]);
	});

	it("hands a wake over at the turn the session starts after a final reply, so a settle that follows finds nothing held", () => {
		const { loop, reported } = shadow();
		loop.runStarted();
		const ticket = loop.emitted([event("j1")], [source], true, false);
		loop.sent(ticket, true);
		loop.stepEnded(true);
		loop.turnStarted();
		loop.settled(false);
		expect(loop.end()).toEqual([]);
		expect(reported).toEqual([]);
		expect(loop.stats().loopTurns).toBe(1);
	});

	it("reports each difference once, when the session ends", () => {
		const { loop, reported } = shadow();
		const ticket = loop.emitted([event("j1")], [source], true, false);
		loop.sent(ticket, true);
		expect(reported).toEqual([]);
		expect(loop.end()).toEqual([]);
		expect(loop.end()).toEqual([]);
	});

	it("reports a wake the loop still holds when the session settles without it", () => {
		const { loop, reported } = shadow();
		loop.runStarted();
		loop.emitted([event("j1")], [source], true, false);
		loop.settled(false);
		loop.end();
		expect(reported.map((diff) => diff.kind)).toContain("phantom-continue");
	});
});
