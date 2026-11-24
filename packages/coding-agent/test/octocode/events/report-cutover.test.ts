import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_DEFAULTS } from "../../../src/core/settings-schema/runtime.ts";
import { recordsEvent, isDeduped, isDurable } from "../../../src/octocode/events/loop/cutover.ts";
import { sendAgentReport } from "../../../src/octocode/subagents/handoff/wake.ts";
import { Mail } from "../../../src/octocode/team/mail.ts";
import type { Message } from "../../../src/octocode/team/model.ts";
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
async function newRig(options: RigOptions = {}, windowSeconds: number | null = WINDOW_S) {
	const rig = await createRig({
		...options,
		settings: {
			...options.settings,
			runtime: { eventWindowSeconds: windowSeconds ?? RUNTIME_DEFAULTS.eventWindowSeconds },
		},
	});
	rigs.push(rig);
	return rig;
}

const result = (id: string) => ({ id, profile: "worker", outcome: "completed", status: "completed" });
const report = (id: string, wake = true) =>
	({ content: `REPORT-${id}`, details: result(id), wake, reportId: id }) as never;
const reportOf = (rig: Rig, id: string) => sendAgentReport(rig.api, report(id), {}, undefined, true);

let nextId = 1;
const mailText = (text: string, extra: Partial<Message> = {}): Message => ({
	id: nextId++,
	from: "parent-1",
	to: "me",
	text,
	at: Date.now(),
	replyRequired: false,
	wake: true,
	...extra,
});
const deliverMail = (rig: Rig, ...messages: Message[]) => new Mail(rig.api).deliver(messages, "parent-1", rig.ctx);
const queuedCount = (rig: Rig) => Object.values(rig.live()?.queued() ?? {}).reduce((sum, each) => sum + each, 0);

describe("the report, end and mail cut-over", () => {
	it("delivers these topics through the loop, durably, and the others through the gate", () => {
		const report = { kind: "agent.report", agent: "c", role: "w", outcome: "ok", reportId: "r1" } as const;
		const ended = { kind: "agent.ended", agent: "c", reason: "done" } as const;
		const mail = { kind: "agent.message", from: "p", id: 1, replyRequired: false, interrupt: false } as const;
		for (const event of [report, ended, mail]) {
			expect(recordsEvent(event)).toBe(true);
			expect(isDurable(event)).toBe(true);
		}
		// A report or mail sent twice is one event; a child can end, be restarted and end again.
		expect([isDeduped(report), isDeduped(mail), isDeduped(ended)]).toEqual([true, true, false]);
		expect(recordsEvent({ kind: "wake.retry", attempt: 1, error: "x" })).toBe(false);
	});

	it("delivers a report once, through the loop's window, with its source header", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("read it")]);
		const started = Date.now();
		const sent = reportOf(rig, "a");
		await vi.waitFor(() => expect(rig.live()?.queued()).toMatchObject({ Q3: 1 }));
		await sleep(WINDOW_S * 250);
		expect(rig.requests).toHaveLength(0);
		await sent;
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(Date.now() - started).toBeGreaterThanOrEqual(WINDOW_S * 1000 - 50);
		expect(count(rig.requests[0], "REPORT-a")).toBe(1);
		expect(count(branchLines(rig.harness), "REPORT-a")).toBe(1);
		expect(rig.requests[0].some((line) => line.includes("[src "))).toBe(true);
		expect(queuedCount(rig)).toBe(0);
	});

	it("is delivered once when the producer sends the same report twice", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("read it"), rig.reply("unexpected")]);
		const sends = Promise.all([reportOf(rig, "dup"), reportOf(rig, "dup")]);
		await sends;
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(branchLines(rig.harness), "REPORT-dup")).toBe(1);
	});

	it("wakes once for two reports within the default window, and the turn carries both", async () => {
		// The default window is what a session runs with (2 s).
		const rig = await newRig({}, null);
		rig.harness.setResponses([rig.reply("read both"), rig.reply("unexpected second turn")]);
		const first = reportOf(rig, "a");
		await sleep(600);
		const second = reportOf(rig, "b");
		await Promise.all([first, second]);
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(rig.requests).toHaveLength(1);
		expect(count(rig.requests[0], "REPORT-a")).toBe(1);
		expect(count(rig.requests[0], "REPORT-b")).toBe(1);
	});

	it("delivers team mail through the loop, once", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("read it")]);
		expect(deliverMail(rig, mailText("MAIL-A"))).toBe(true);
		expect(rig.live()?.queued()).toMatchObject({ Q3: 1 });
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "MAIL-A")).toBe(1);
		expect(count(branchLines(rig.harness), "MAIL-A")).toBe(1);
		expect(rig.requests[0].some((line) => line.includes("[src "))).toBe(true);
	});

	it("never holds user input: a prompt during the window runs at once, and the report follows once", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("user answer"), rig.reply("report answer")]);
		const sent = reportOf(rig, "a");
		const began = Date.now();
		await rig.harness.session.prompt("typed by the user");
		expect(Date.now() - began).toBeLessThan(WINDOW_S * 1000);
		expect(rig.requests[0].some((line) => line.includes("typed by the user"))).toBe(true);
		await sent;
		await vi.waitFor(() => expect(count(rig.requests.flat(), "REPORT-a")).toBeGreaterThanOrEqual(1), {
			timeout: 10_000,
		});
		await rig.harness.session.waitForIdle();
		expect(count(branchLines(rig.harness), "REPORT-a")).toBe(1);
	});

	it("queues mail behind a compaction and delivers it once after the summary", async () => {
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
		expect(deliverMail(rig, mailText("MAIL-C"))).toBe(true);
		await sleep(WINDOW_S * 1000 + 200);
		expect(rig.harness.session.isCompacting).toBe(true);
		expect(rig.requests).toHaveLength(0);
		expect(count(branchLines(rig.harness), "MAIL-C")).toBe(0);
		expect(queuedCount(rig)).toBeGreaterThan(0);
		gate.release();
		await running;
		await vi.waitFor(() => expect(count(rig.requests.flat(), "MAIL-C")).toBe(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		const branch = branchLines(rig.harness);
		expect(branch.findIndex((line) => line.includes("MAIL-C"))).toBeGreaterThan(branch.indexOf("compaction"));
		expect(count(branch, "MAIL-C")).toBe(1);
	});

	it("replays queued mail once after a restart, with its source header", async () => {
		// The first session queues the mail in a long window and goes away before it is delivered.
		const first = await newRig({}, 10);
		deliverMail(first, mailText("MAIL-RESTART"));
		await vi.waitFor(() => expect(first.live()?.queued()).toMatchObject({ Q3: 1 }));
		const earlier = {
			cwd: first.ctx.cwd,
			sessionManager: { getSessionId: () => first.ctx.sessionManager.getSessionId() },
		};

		// The resumed session finds it in the event log and delivers it after its own window.
		const second = await newRig({ liveStore: () => sessionStore(earlier) });
		second.harness.setResponses([second.reply("read it"), second.reply("unexpected")]);
		expect(second.live()?.queued()).toMatchObject({ Q3: 1 });
		await vi.waitFor(() => expect(second.requests).toHaveLength(1), { timeout: 10_000 });
		await second.harness.session.waitForIdle();
		expect(count(second.requests[0], "MAIL-RESTART")).toBe(1);
		expect(second.requests[0].some((line) => line.includes("[src "))).toBe(true);

		// Delivered: a third start of the same session finds nothing left.
		const third = await newRig({ liveStore: () => sessionStore(earlier) });
		expect(queuedCount(third)).toBe(0);
		await sleep(WINDOW_S * 1000 + 200);
		expect(third.requests).toHaveLength(0);
	});

	it("replays a queued report after a restart, and a delivered one is not replayed again", async () => {
		const first = await newRig({}, 10);
		void reportOf(first, "gone");
		await vi.waitFor(() => expect(first.live()?.queued()).toMatchObject({ Q3: 1 }));
		const earlier = {
			cwd: first.ctx.cwd,
			sessionManager: { getSessionId: () => first.ctx.sessionManager.getSessionId() },
		};
		const second = await newRig({ liveStore: () => sessionStore(earlier) });
		second.harness.setResponses([second.reply("read it")]);
		await vi.waitFor(() => expect(second.requests).toHaveLength(1), { timeout: 10_000 });
		expect(count(second.requests[0], "REPORT-gone")).toBe(1);
		await second.harness.session.waitForIdle();
		expect(count(branchLines(second.harness), "REPORT-gone")).toBe(1);
		const third = await newRig({ liveStore: () => sessionStore(earlier) });
		await sleep(WINDOW_S * 1000 + 200);
		expect(queuedCount(third)).toBe(0);
		expect(third.requests).toHaveLength(0);
	});

	it("does not replay another session's events", async () => {
		const first = await newRig({}, 10);
		deliverMail(first, mailText("MAIL-OTHER"));
		await vi.waitFor(() => expect(first.live()?.queued()).toMatchObject({ Q3: 1 }));
		const second = await newRig({ settings: { subagents: {} } });
		expect(queuedCount(second)).toBe(0);
	});

	it("delivers a child's end through the loop", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("saw it")]);
		const sent = wakeGateOf(rig.api).emit(
			{ kind: "agent.ended", agent: "child-1", reason: "done" },
			{ customType: "loop-test", content: "ENDED-child-1", display: true },
			{ triggerTurn: true, deliverAs: "followUp", together: true },
		);
		expect(rig.live()?.queued()).toMatchObject({ Q3: 1 });
		await sent;
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "ENDED-child-1")).toBe(1);
	});
});
