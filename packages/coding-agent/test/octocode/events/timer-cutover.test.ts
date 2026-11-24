import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordsEvent, isDeduped, isDurable } from "../../../src/octocode/events/loop/cutover.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";
import { sessionStore } from "../../../src/octocode/wake/live-durable.ts";
import {
	branchLines,
	count,
	createRig,
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

/** One event per cut-over topic of R8, with whether a repeat of the same event is dropped. */
const KINDS: { name: string; event: (tag: string) => PayloadEvent; once: boolean }[] = [
	{ name: "time.due", once: true, event: (tag) => ({ kind: "time.due", timerId: 7, run: tag.length, note: tag }) },
	{ name: "check.result", once: false, event: (tag) => ({ kind: "check.result", timerId: 8, exit: 0, output: tag }) },
	{ name: "item.state", once: false, event: (tag) => ({ kind: "item.state", ref: `B${tag.length}`, state: "done" }) },
	{ name: "item.changed", once: false, event: (tag) => ({ kind: "item.changed", ref: tag, change: "note", by: "p" }) },
	{ name: "path.unlocked", once: false, event: (tag) => ({ kind: "path.unlocked", path: `src/${tag}.ts` }) },
	{ name: "peer.landed", once: false, event: (tag) => ({ kind: "peer.landed", ref: tag, how: "done" }) },
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
const queuedCount = (rig: Rig) => Object.values(rig.live()?.queued() ?? {}).reduce((sum, each) => sum + each, 0);
const earlierOf = (rig: Rig) => ({
	cwd: rig.ctx.cwd,
	sessionManager: { getSessionId: () => rig.ctx.sessionManager.getSessionId() },
});

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
	});

	describe.each(KINDS)("$name", (kind) => {
		it("is delivered once, through the loop's window", async () => {
			const rig = await newRig();
			rig.harness.setResponses([rig.reply("read it"), rig.reply("unexpected")]);
			const sent = send(rig, kind, "TAG-once");
			expect(rig.live()?.queued()).toMatchObject({ Q3: 1 });
			await sent;
			await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
			await rig.harness.session.waitForIdle();
			expect(count(rig.requests[0], "TAG-once")).toBe(1);
			expect(count(branchLines(rig.harness), "TAG-once")).toBe(1);
			expect(queuedCount(rig)).toBe(0);
		});

		it("merges with another inside the window into one turn", async () => {
			const rig = await newRig({}, 1);
			rig.harness.setResponses([rig.reply("read both"), rig.reply("unexpected second turn")]);
			const first = send(rig, kind, "TAG-a");
			await sleep(300);
			const second = send(rig, kind, "TAG-bb");
			await Promise.all([first, second]);
			await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
			await rig.harness.session.waitForIdle();
			expect(rig.requests).toHaveLength(1);
			expect(count(rig.requests[0], "TAG-a")).toBe(1);
			expect(count(rig.requests[0], "TAG-bb")).toBe(1);
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
			expect(queuedCount(rig)).toBeGreaterThan(0);
			gate.release();
			await running;
			await vi.waitFor(() => expect(count(rig.requests.flat(), "TAG-compact")).toBe(1), { timeout: 10_000 });
			await rig.harness.session.waitForIdle();
			const branch = branchLines(rig.harness);
			expect(branch.findIndex((line) => line.includes("TAG-compact"))).toBeGreaterThan(branch.indexOf("compaction"));
			expect(count(branch, "TAG-compact")).toBe(1);
		});

		it("replays once after a restart, and not again after it was delivered", async () => {
			const first = await newRig({}, 10);
			void send(first, kind, "TAG-restart");
			await vi.waitFor(() => expect(first.live()?.queued()).toMatchObject({ Q3: 1 }));
			const earlier = earlierOf(first);

			const second = await newRig({ liveStore: () => sessionStore(earlier) });
			second.harness.setResponses([second.reply("read it"), second.reply("unexpected")]);
			expect(second.live()?.queued()).toMatchObject({ Q3: 1 });
			await vi.waitFor(() => expect(second.requests).toHaveLength(1), { timeout: 10_000 });
			await second.harness.session.waitForIdle();
			expect(count(second.requests[0], "TAG-restart")).toBe(1);

			const third = await newRig({ liveStore: () => sessionStore(earlier) });
			expect(queuedCount(third)).toBe(0);
			await sleep(WINDOW_S * 1000 + 200);
			expect(third.requests).toHaveLength(0);
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
