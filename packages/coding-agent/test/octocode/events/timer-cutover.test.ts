import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EVENT_WINDOW_SECONDS } from "../../../src/core/settings-schema/runtime.ts";
import { recordsEvent, isDeduped, isDurable } from "../../../src/octocode/events/loop/cutover.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";
import { sessionStore } from "../../../src/octocode/wake/live-durable.ts";
import {
	branchLines,
	count,
	createRig,
	expectHeld,
	expectLogged,
	pendingWakes,
	quiet,
	recordedTopics,
	sessionOf,
	sleep,
	wakeGateOf,
	type Rig,
	type RigOptions,
} from "../loop-characterization/rig.ts";
import { gateSummary } from "../loop-characterization/summary-gate.ts";

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

const WINDOW_S = 0.4;
async function newRig(options: RigOptions = {}, windowSeconds = WINDOW_S) {
	const rig = await createRig({
		...options,
		settings: { ...options.settings, runtime: { eventWindowSeconds: windowSeconds } },
	});
	rigs.push(rig);
	return rig;
}

/** A window no test waits out (the longest there is). */
const LONG_WINDOW_S = MAX_EVENT_WINDOW_SECONDS;

/** One event per cut-over topic of R8, with whether a repeat of the same event is dropped. */
const KINDS: { name: string; event: (tag: string) => PayloadEvent; once: boolean }[] = [
	{ name: "time.due", once: true, event: (tag) => ({ kind: "time.due", timerId: 7, run: tag.length, note: tag }) },
	{ name: "check.result", once: false, event: (tag) => ({ kind: "check.result", timerId: 8, exit: 0, output: tag }) },
	{
		name: "item.peer",
		once: true,
		event: (tag) => ({ kind: "item.peer", ref: "B1", change: "done", by: "p", relation: "dep", id: tag.length }),
	},
];

const send = (rig: Rig, kind: (typeof KINDS)[number], tag: string) =>
	wakeGateOf(rig.api).emit(
		kind.event(tag),
		{ customType: "loop-test", content: tag, display: true },
		{ triggerTurn: true, deliverAs: "followUp", together: true },
	);
/**
 * One topic per persistence class. What a session does with a recorded wake (merging in the window, waiting behind a
 * compaction, replaying after a restart) depends on its class and never on its topic, and the table test above pins the
 * class of every topic; so those three behaviours are run once per class, and plain delivery for every topic.
 */
const PER_CLASS = [
	KINDS.find((kind) => kind.name === "time.due")!, // once: a repeat is dropped
	KINDS.find((kind) => kind.name === "check.result")!, // durable: a repeat is a new event
];

describe("the timer, notify and backlog-feed cut-over", () => {
	it("lists each topic as delivered by the loop and durable, and drops repeats only of time.due and item.peer", () => {
		for (const kind of KINDS) {
			const event = kind.event("x");
			expect([kind.name, recordsEvent(event), isDurable(event), isDeduped(event)]).toEqual([
				kind.name,
				true,
				true,
				kind.once,
			]);
		}
		// The classes the per-class cases below stand for are exactly the classes this table has.
		expect(new Set(KINDS.map((kind) => kind.once))).toEqual(new Set(PER_CLASS.map((kind) => kind.once)));
	});

	it.each(KINDS)("$name is recorded, then delivered once in a turn of its own after the window", async (kind) => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("read it"), rig.reply("unexpected")]);
		const sent = send(rig, kind, "TAG-once");
		// The loop has it: the session shows a wake about to resume it.
		expect(pendingWakes(rig)).toHaveLength(1);
		await sent;
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await quiet(rig);
		expect(rig.requests).toHaveLength(1);
		expect(count(rig.requests[0], "TAG-once")).toBe(1);
		expect(count(branchLines(rig.harness), "TAG-once")).toBe(1);
		expect(pendingWakes(rig)).toEqual([]);
		expect(rig.harness.getPendingResponseCount()).toBe(1);
		// Recorded under its topic in the session's log, and no longer owed.
		expect(await recordedTopics(rig)).toEqual([kind.name]);
		await expectLogged(rig, 0);
	});

	describe.each(PER_CLASS)("$name", (kind) => {
		it("merges with another inside the window into one turn", async () => {
			const rig = await newRig({}, 1);
			rig.harness.setResponses([rig.reply("read both"), rig.reply("unexpected second turn")]);
			await send(rig, kind, "TAG-a");
			// Held: the session had every chance to start a turn for the first one and did not.
			await expectHeld(rig, "TAG-a");
			await send(rig, kind, "TAG-bb");
			await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
			await quiet(rig);
			expect(rig.requests).toHaveLength(1);
			expect(count(rig.requests[0], "TAG-a")).toBe(1);
			expect(count(rig.requests[0], "TAG-bb")).toBe(1);
			expect(rig.harness.getPendingResponseCount()).toBe(1);
		});

		it("is queued during a compaction and delivered once after the summary", async () => {
			const rig = await newRig({
				models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 100 }],
				compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
			});
			rig.harness.setResponses([
				fauxAssistantMessage(`s1:${"a".repeat(7500)}`),
				fauxAssistantMessage(`s2:${"b".repeat(7500)}`),
				fauxAssistantMessage(`s3:${"c".repeat(7500)}`),
				fauxAssistantMessage(`s4:${"d".repeat(1500)}`),
				fauxAssistantMessage(`big:${"e".repeat(5000)}`),
				rig.reply("after the summary"),
				rig.reply("unexpected"),
			]);
			for (const turn of ["s1", "s2", "s3", "s4"]) await rig.harness.session.prompt(`seed ${turn}`);
			rig.requests.length = 0;
			const gate = gateSummary(rig.harness.session);
			const running = rig.harness.session.prompt("go big");
			await gate.started;
			expect(rig.harness.session.isCompacting).toBe(true);
			void send(rig, kind, "TAG-compact");
			await sleep(WINDOW_S * 1000 + 200);
			expect(rig.requests).toHaveLength(0);
			expect(count(branchLines(rig.harness), "TAG-compact")).toBe(0);
			// Not lost: the session's log holds it for the moment the lock is released.
			await expectLogged(rig, 1);
			gate.release();
			await running;
			await vi.waitFor(() => expect(count(rig.requests.flat(), "TAG-compact")).toBe(1), { timeout: 10_000 });
			await rig.harness.session.waitForIdle();
			const branch = branchLines(rig.harness);
			expect(branch.findIndex((line) => line.includes("TAG-compact"))).toBeGreaterThan(branch.indexOf("compaction"));
			expect(count(branch, "TAG-compact")).toBe(1);
		});

		it("replays once after a restart, and not again after it was delivered", async () => {
			const first = await newRig({}, LONG_WINDOW_S);
			await send(first, kind, "TAG-restart");
			await expectLogged(first, 1);
			const earlier = sessionOf(first);

			const second = await newRig({ liveStore: () => sessionStore(earlier) });
			second.harness.setResponses([second.reply("read it"), second.reply("unexpected")]);
			expect(pendingWakes(second)).toHaveLength(1);
			await vi.waitFor(() => expect(second.requests).toHaveLength(1), { timeout: 10_000 });
			await quiet(second);
			expect(second.requests).toHaveLength(1);
			expect(count(second.requests[0], "TAG-restart")).toBe(1);
			expect(count(branchLines(second.harness), "TAG-restart")).toBe(1);

			// Delivered: a third start has read its log by the time it is ready, and found nothing left.
			const third = await newRig({ liveStore: () => sessionStore(earlier) });
			third.harness.setResponses([third.reply("unexpected")]);
			expect(pendingWakes(third)).toEqual([]);
			await quiet(third);
			expect(third.requests).toHaveLength(0);
			expect(count(branchLines(third.harness), "TAG-restart")).toBe(0);
		});
	});

	it.each(KINDS.filter((kind) => kind.once))("$name sent twice is delivered once", async (kind) => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("read it"), rig.reply("unexpected")]);
		await Promise.all([send(rig, kind, "TAG-dup"), send(rig, kind, "TAG-dup")]);
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(branchLines(rig.harness), "TAG-dup")).toBe(1);
	});
});
