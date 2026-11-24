import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { lockSessionFile } from "../../../src/core/session-manager/shared-file.ts";
import { MemoryEventStore } from "../../../src/octocode/events/loop/store.ts";
import { JOB_TYPE, TASK_TYPE } from "../../../src/octocode/shared/messages.ts";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordsEvent } from "../../../src/octocode/events/loop/cutover.ts";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";
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
const directories: string[] = [];
function diskSession() {
	const dir = mkdtempSync(join(tmpdir(), "event-receipt-"));
	directories.push(dir);
	return SessionManager.create(dir, dir);
}
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WINDOW_S = 0.4;
const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });
const message = (job: string) => ({ customType: "loop-test", content: `EXIT-${job}`, display: true });
const send = (rig: Rig, job: string) =>
	wakeGateOf(rig.api).emit(exit(job), message(job), { triggerTurn: true, deliverAs: "followUp", together: true });

async function newRig(options: RigOptions = {}) {
	const rig = await createRig({
		...options,
		settings: { ...options.settings, runtime: { eventWindowSeconds: WINDOW_S } },
	});
	rigs.push(rig);
	return rig;
}

describe("the job.exit cut-over", () => {
	it("records job exits and keeps retry notifications in memory", () => {
		expect(recordsEvent(exit("bash-1"))).toBe(true);
		expect(recordsEvent({ kind: "wake.retry", attempt: 1, error: "x" })).toBe(false);
	});

	it.each([
		[TASK_TYPE, "task-1"],
		[JOB_TYPE, "bash-1"],
	])("recovers %s with its ID and drops a repeated completion", async (customType, id) => {
		const store = new MemoryEventStore();
		const first = await newRig({ liveStore: () => store });
		const gate = wakeGateOf(first.api);
		const content = `[${id}] recovered result`;
		const message = { customType, content, display: true };
		const options = { triggerTurn: true, deliverAs: "steer" as const };
		await gate.emit(exit(id), message, options);
		await gate.emit(exit(id), message, options);
		expect(first.live()?.queued().Q3).toBe(1);
		const recovered = await newRig({ liveStore: () => store });
		recovered.harness.setResponses([recovered.reply("received")]);
		await recovered.harness.session.prompt("resume");
		expect(recovered.requests).toHaveLength(1);
		expect(count(recovered.requests[0], content)).toBe(1);
		expect(store.unread()).toEqual([]);
		first.harness.setResponses([first.reply("end")]);
		first.live()?.end();
	});

	it.each(["first", "second"])(
		"replays only the rejected %s completion and wakes the resumed session once",
		async (rejected) => {
			const store = new MemoryEventStore();
			const sessionManager = diskSession();
			const rig = await newRig({ liveStore: () => store, sessionManager });
			const original = rig.harness.session.sendCustomMessage.bind(rig.harness.session);
			const attempted = vi.spyOn(rig.harness.session, "sendCustomMessage").mockImplementation(async (msg, opts) => {
				if (String(msg.content).includes(`EXIT-${rejected}`)) throw new Error("session refused the handoff");
				await original(msg, opts);
				throw new Error("failure after acceptance");
			});
			rig.harness.setResponses([rig.reply("received")]);
			await send(rig, "first");
			await send(rig, "second");
			await vi.waitFor(() => expect(attempted).toHaveBeenCalledTimes(2), { timeout: 5_000 });
			await rig.harness.session.waitForIdle();
			rig.live()?.end();
			const next = await newRig({
				liveStore: () => store,
				sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
			});
			expect(next.live()?.queued().Q3).toBe(1);
			next.harness.setResponses([next.reply("recovered")]);
			await vi.waitFor(() => expect(next.requests).toHaveLength(1), { timeout: 5_000 });
			await next.harness.session.waitForIdle();
			const history = branchLines(next.harness);
			for (const id of ["first", "second"]) expect(count(history, `EXIT-${id}`)).toBe(1);
			expect(store.unread()).toEqual([]);
		},
	);

	it("keeps a completion replayable while the transcript writer is locked, then releases it after the write", async () => {
		const store = new MemoryEventStore();
		const sessionManager = diskSession();
		const rig = await newRig({ liveStore: () => store, sessionManager });
		const file = sessionManager.getSessionFile()!;
		const release = lockSessionFile(file);
		try {
			await send(rig, "locked");
			rig.live()?.end();
			expect(count(branchLines(rig.harness), "EXIT-locked")).toBe(1);
			expect(store.unread()).toHaveLength(1);
			const rebound = await newRig({ liveStore: () => store, sessionManager });
			expect(rebound.live()?.queued().Q3).toBe(0);
			expect(store.unread()).toHaveLength(1);
		} finally {
			release();
		}
		await vi.waitFor(() => expect(store.unread()).toHaveLength(0));
		expect(SessionManager.open(file).getBranch()).toContainEqual(
			expect.objectContaining({ content: expect.stringContaining("EXIT-locked") }),
		);
		expect(rig.requests).toHaveLength(0);
	});

	it("delivers an exit once, through the loop's window", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("saw the exit")]);
		const started = Date.now();
		const sent = send(rig, "bash-1");
		expect(rig.live()).toBeDefined();
		expect(rig.live()?.queued()).toMatchObject({ Q3: 1 });
		await sleep(WINDOW_S * 250);
		expect(rig.requests).toHaveLength(0);
		await sent;
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(Date.now() - started).toBeGreaterThanOrEqual(WINDOW_S * 1000 - 50);
		expect(count(rig.requests[0], "EXIT-bash-1")).toBe(1);
		expect(count(branchLines(rig.harness), "EXIT-bash-1")).toBe(1);
		// The gate did not hold it too: it sent nothing of its own and shows no wake left.
		expect(rig.live()?.queued()).toMatchObject({ Q1: 0, Q2: 0, Q3: 0 });
	});

	it("wakes once for two exits within the window, and the turn carries both", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("saw both"), rig.reply("unexpected second turn")]);
		const first = send(rig, "bash-1");
		await sleep(WINDOW_S * 300);
		const second = send(rig, "bash-2");
		await Promise.all([first, second]);
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(rig.requests).toHaveLength(1);
		expect(count(rig.requests[0], "EXIT-bash-1")).toBe(1);
		expect(count(rig.requests[0], "EXIT-bash-2")).toBe(1);
	});

	it("uses one wake for a job and a peer notice from different producers", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("handled both"), rig.reply("unexpected")]);
		await send(rig, "bash-1");
		await wakeGateOf(rig.api).emit(
			{ kind: "peer.notice", text: "peer arrived", seq: 1 },
			{
				customType: "peer",
				content: "peer arrived",
				display: true,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
		expect(rig.live()?.queued().Q3).toBe(2);
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "EXIT-bash-1")).toBe(1);
		expect(count(rig.requests[0], "peer arrived")).toBe(1);
		expect(rig.harness.getPendingResponseCount()).toBe(1);
	});

	it("never holds user input: a prompt during the window runs at once, and the exit is delivered once after it", async () => {
		const rig = await newRig();
		rig.harness.setResponses([rig.reply("user answer"), rig.reply("exit answer")]);
		const sent = send(rig, "bash-1");
		const began = Date.now();
		await rig.harness.session.prompt("typed by the user");
		expect(Date.now() - began).toBeLessThan(WINDOW_S * 1000);
		expect(rig.requests[0].some((line) => line.includes("typed by the user"))).toBe(true);
		await sent;
		await vi.waitFor(() => expect(count(rig.requests.flat(), "EXIT-bash-1")).toBeGreaterThanOrEqual(1), {
			timeout: 10_000,
		});
		await rig.harness.session.waitForIdle();
		expect(count(branchLines(rig.harness), "EXIT-bash-1")).toBe(1);
	});

	it("queues an exit behind a compaction lock and delivers it once after the summary", async () => {
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
		const sent = send(rig, "bash-1");
		// Longer than the window: a locked loop still does not deliver.
		await sleep(WINDOW_S * 1000 + 200);
		expect(rig.requests).toHaveLength(0);
		expect(count(branchLines(rig.harness), "EXIT-bash-1")).toBe(0);
		gate.release();
		await running;
		await sent;
		await vi.waitFor(() => expect(count(rig.requests.flat(), "EXIT-bash-1")).toBe(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		const branch = branchLines(rig.harness);
		expect(branch.findIndex((line) => line.includes("EXIT-bash-1"))).toBeGreaterThan(branch.indexOf("compaction"));
		expect(count(branch, "EXIT-bash-1")).toBe(1);
	});

	it("delivers what is queued at the session's end, without starting a turn", async () => {
		const rig = await newRig();
		const sent = send(rig, "bash-1");
		rig.live()?.end();
		await sent;
		expect(rig.requests).toHaveLength(0);
		expect(count(branchLines(rig.harness), "EXIT-bash-1")).toBe(1);
	});
});
