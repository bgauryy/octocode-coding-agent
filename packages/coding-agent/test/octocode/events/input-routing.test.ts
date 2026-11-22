import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { withInputOrigin } from "../../../src/core/input-origin.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";
import type { Held } from "../../../src/octocode/wake/gate.ts";
import { blockingTool, count, createRig, type Rig } from "../loop-characterization/rig.ts";

/** User input under `runtime.eventLoop: new` (RFC agent-event-loop R9): Q1 with its channel, never held, source header on the prompt. */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

async function newRig(eventLoop: "old" | "new", tools: Parameters<typeof createRig>[0] = {}) {
	const r = await createRig({ ...tools, settings: { runtime: { eventLoop, eventWindowSeconds: 60 } } });
	rigs.push(r);
	return r;
}

const jobExit = (job: string): PayloadEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });

function heldWake(r: Rig, job: string) {
	const held: Held = {
		labels: [job],
		message: { customType: "x", content: `wake ${job}`, display: false },
		options: {},
		done: { resolve() {}, reject() {} },
	};
	r.live()?.take({
		event: jobExit(job),
		source: makeSource("job", job, "in-process", "proven"),
		wake: true,
		steer: false,
		carry: held,
	});
}

const userLine = (r: Rig) => r.requests[0].find((line) => line.startsWith("user:")) ?? "";

describe("user input through the loop", () => {
	it("reaches the model with the terminal's source header", async () => {
		const r = await newRig("new");
		r.harness.setResponses([r.reply("ok")]);
		await r.harness.session.prompt("hello there");
		expect(userLine(r)).toMatch(/^user:\[src terminal:terminal ✓proven via terminal\] t4\nhello there$/);
	});

	it.each(["acp", "web"] as const)("carries the %s channel and less trust than the terminal", async (channel) => {
		const r = await newRig("new");
		r.harness.setResponses([r.reply("ok")]);
		await withInputOrigin(channel, () => r.harness.session.prompt("from afar"));
		expect(userLine(r)).toContain(`[src ${channel}:${channel} ✓proven via ${channel}] t3\nfrom afar`);
	});

	it("leaves a skill or template command and a feature's own input as typed", async () => {
		const r = await newRig("new");
		r.harness.setResponses([r.reply("ok"), r.reply("ok")]);
		await r.harness.session.prompt("plain /not-a-command");
		await r.harness.session.prompt("/not-a-command at the start", { source: "feature" });
		expect(r.requests[1].at(-1)).toBe("user:/not-a-command at the start");
	});

	it("adds no header in old mode", async () => {
		const r = await newRig("old");
		r.harness.setResponses([r.reply("ok")]);
		await r.harness.session.prompt("hello there");
		expect(userLine(r)).toBe("user:hello there");
	});

	it("is not held by the window: the events it holds go out with it, once, and it starts one turn", async () => {
		const r = await newRig("new");
		r.harness.setResponses([r.reply("ok"), r.reply("unexpected second turn")]);
		heldWake(r, "job-1");
		expect(r.live()?.queued().Q3).toBe(1);
		await r.harness.session.prompt("now");
		expect(r.live()?.queued()).toEqual({ Q1: 0, Q2: 0, Q3: 0 });
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "wake job-1")).toBe(1);
	});

	it("runs a Stop at once while the loop holds events, and the window does not delay it", async () => {
		const slow = blockingTool();
		const r = await newRig("new", { tools: [slow.tool] });
		r.harness.setResponses([fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })]);
		const run = r.harness.session.prompt("go");
		await slow.started;
		heldWake(r, "job-2");
		await withInputOrigin("web", () => r.harness.session.abort());
		// Stop did not wait for the 60 s window: the run is over (the tool is still blocked, so only Stop ended it).
		await run.catch(() => undefined);
		expect(r.harness.session.isStreaming).toBe(false);
		slow.release();
	});
});
