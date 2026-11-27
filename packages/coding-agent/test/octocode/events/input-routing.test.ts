import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { withInputOrigin } from "../../../src/core/input-origin.ts";
import { MAX_EVENT_WINDOW_SECONDS } from "../../../src/core/settings-schema/runtime.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";
import {
	blockingTool,
	branchLines,
	count,
	createRig,
	expectHeld,
	pendingWakes,
	quiet,
	wakeGateOf,
	type Rig,
} from "../loop-characterization/rig.ts";

/** User input: Q1 with its channel, never held, source header on the prompt. */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

async function newRig(tools: Parameters<typeof createRig>[0] = {}) {
	// The longest window there is: no test here waits it out.
	const r = await createRig({ ...tools, settings: { runtime: { eventWindowSeconds: MAX_EVENT_WINDOW_SECONDS } } });
	rigs.push(r);
	return r;
}

const jobExit = (job: string): PayloadEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });

/** A background completion sent the way every producer sends one: through the gate, asking for a turn. */
const heldWake = (r: Rig, job: string) =>
	wakeGateOf(r.api).emit(
		jobExit(job),
		{ customType: "x", content: `wake ${job}`, display: false },
		{ triggerTurn: true },
	);

const BEFORE_THE_WINDOW_ENDS_MS = (MAX_EVENT_WINDOW_SECONDS - 2) * 1000;

const userLine = (r: Rig) => r.requests[0].find((line) => line.startsWith("user:")) ?? "";

describe("user input through the loop", () => {
	it("reaches the model with the terminal's source header", async () => {
		const r = await newRig();
		r.harness.setResponses([r.reply("ok")]);
		await r.harness.session.prompt("hello there");
		expect(userLine(r)).toMatch(/^user:\[src terminal:terminal ✓proven via terminal\] t4\nhello there$/);
	});

	it.each(["acp", "web"] as const)("carries the %s channel and less trust than the terminal", async (channel) => {
		const r = await newRig();
		r.harness.setResponses([r.reply("ok")]);
		await withInputOrigin(channel, () => r.harness.session.prompt("from afar"));
		expect(userLine(r)).toContain(`[src ${channel}:${channel} ✓proven via ${channel}] t3\nfrom afar`);
	});

	it("leaves a skill or template command and a feature's own input as typed", async () => {
		const r = await newRig();
		r.harness.setResponses([r.reply("ok"), r.reply("ok")]);
		await r.harness.session.prompt("plain /not-a-command");
		await r.harness.session.prompt("/not-a-command at the start", { source: "feature" });
		expect(r.requests[1].at(-1)).toBe("user:/not-a-command at the start");
	});

	it(
		"is not held by the window: the events it holds go out with it, once, and it starts one turn",
		async () => {
			const r = await newRig();
			r.harness.setResponses([r.reply("ok"), r.reply("unexpected second turn")]);
			await heldWake(r, "job-1");
			await expectHeld(r, "wake job-1");
			// A prompt the window held would wait the window out and hit this test's timeout, which is shorter.
			await r.harness.session.prompt("now");
			await quiet(r);
			expect(r.requests).toHaveLength(1);
			// The typed text is the last thing the model reads; the held wake is in front of it.
			expect(r.requests[0].at(-1)).toMatch(/^user:\[src terminal:terminal [^\n]*\nnow$/);
			expect(count(r.requests[0], "wake job-1")).toBe(1);
			expect(count(branchLines(r.harness), "wake job-1")).toBe(1);
			expect(pendingWakes(r)).toEqual([]);
			expect(r.harness.getPendingResponseCount()).toBe(1);
		},
		BEFORE_THE_WINDOW_ENDS_MS,
	);

	it(
		"runs a Stop at once while the loop holds events, and the stop is not answered with a new turn",
		async () => {
			const slow = blockingTool();
			const r = await newRig({ tools: [slow.tool] });
			r.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
				r.reply("unexpected turn after the stop"),
			]);
			const run = r.harness.session.prompt("go");
			await slow.started;
			await heldWake(r, "job-2");
			expect(pendingWakes(r)).toHaveLength(1);
			await withInputOrigin("web", () => r.harness.session.abort());
			// Stop did not wait for the window: the run is over (the tool is still blocked, so only Stop ended it).
			await run.catch(() => undefined);
			await quiet(r);
			expect(r.harness.session.isStreaming).toBe(false);
			// The wake the run held did not start a turn of its own, and nothing is left that would.
			expect(r.requests).toHaveLength(0);
			expect(r.harness.getPendingResponseCount()).toBe(1);
			expect(pendingWakes(r)).toEqual([]);
			expect(r.harness.session.agent.hasQueuedMessages()).toBe(false);
			// The wake is not lost with the stopped run: it is in the conversation once, for the next turn to read.
			expect(count(branchLines(r.harness), "wake job-2")).toBe(1);
			slow.release();
		},
		BEFORE_THE_WINDOW_ENDS_MS,
	);
});
