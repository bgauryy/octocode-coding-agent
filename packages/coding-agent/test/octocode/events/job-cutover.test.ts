import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCutOver } from "../../../src/octocode/events/loop/cutover.ts";
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

/**
 * The first live cut-over (RFC agent-event-loop §14 R6): with `runtime.eventLoop: new` a bash job's exit is delivered by the
 * event loop and its window, not by the wake gate's own hold; in `old` and `shadow` the gate delivers it as before.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

const WINDOW_S = 0.4;
const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });
const message = (job: string) => ({ customType: "loop-test", content: `EXIT-${job}`, display: true });
const send = (rig: Rig, job: string) =>
	wakeGateOf(rig.api).emit(exit(job), message(job), { triggerTurn: true, deliverAs: "followUp", together: true });

async function newRig(mode: "old" | "shadow" | "new", options: RigOptions = {}) {
	const rig = await createRig({
		...options,
		settings: { ...options.settings, runtime: { eventLoop: mode, eventWindowSeconds: WINDOW_S } },
	});
	rigs.push(rig);
	return rig;
}

describe("the job.exit cut-over", () => {
	it("is a topic the loop delivers; the others stay with the gate", () => {
		expect(isCutOver(exit("bash-1"))).toBe(true);
		expect(isCutOver({ kind: "wake.retry", attempt: 1, error: "x" })).toBe(false);
	});

	it("delivers an exit once, through the loop's window, in new mode", async () => {
		const rig = await newRig("new");
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

	it.each(["old", "shadow"] as const)("leaves the exit to the gate, at once, in %s mode", async (mode) => {
		const rig = await newRig(mode);
		rig.harness.setResponses([rig.reply("saw the exit")]);
		await send(rig, "bash-1");
		expect(rig.live()).toBeUndefined();
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 10_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "EXIT-bash-1")).toBe(1);
	});

	it("wakes once for two exits within the window, and the turn carries both", async () => {
		const rig = await newRig("new");
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

	it("never holds user input: a prompt during the window runs at once, and the exit is delivered once after it", async () => {
		const rig = await newRig("new");
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
		const rig = await newRig("new", {
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
		const rig = await newRig("new");
		const sent = send(rig, "bash-1");
		rig.live()?.end();
		await sent;
		expect(rig.requests).toHaveLength(0);
		expect(count(branchLines(rig.harness), "EXIT-bash-1")).toBe(1);
	});
});
