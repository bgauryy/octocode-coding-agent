import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineSample } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { tmp } from "../helpers.ts";
import { registerMonitor } from "../../../src/octocode/monitor/register.ts";
import type { MachineSamplerOptions } from "../../../src/octocode/monitor/sampler.ts";
import { StuckJobWatch } from "../../../src/octocode/monitor/stuck-jobs.ts";
import { sendAgentReport } from "../../../src/octocode/subagents/handoff/wake.ts";
import {
	sendGraphNotice,
	sendHookFeedback,
	sendPeerNotice,
	sendWakeRetry,
} from "../../../src/octocode/wake/senders.ts";
import { blockingTool, count, createRig, type Rig } from "./rig.ts";

/**
 * The hidden and one-off wake producers, driven through their real senders (RFC agent-event-loop R0, §4): graph notice,
 * hook feedback, wake retry and peer notice (wake/senders.ts), a child's report (subagents/handoff/wake.ts:10) and a monitor
 * alert (monitor/register.ts:131). Each case pins how the event reaches an idle session and a busy one.
 * R3/R5 move the producers onto topics; delivery (idle: one turn; busy: steer joins the run, follow-up waits) must not change.
 */

const rigs: Rig[] = [];
const afterEachClose: Array<() => void> = [];
afterEach(() => {
	for (const close of afterEachClose.splice(0)) close();
	for (const rig of rigs.splice(0)) rig.cleanup();
});
async function rig(options: Parameters<typeof createRig>[0] = {}) {
	const made = await createRig(options);
	rigs.push(made);
	return made;
}

const settled = async (r: Rig, turns: number) => {
	await vi.waitFor(() => expect(r.requests).toHaveLength(turns), { timeout: 10_000 });
	await r.harness.session.waitForIdle();
};

type Sender = (r: Rig, text: string) => void | Promise<void>;
/** Sender, the delivery it uses today, and whether the event is hidden (`display: false`). */
const SENDERS: Array<[string, Sender, "followUp" | "steer"]> = [
	["graph notice (item.ready)", (r, text) => sendGraphNotice(r.api, "loop-graph", `${text} B7`), "followUp"],
	["hook feedback (hook.feedback)", (r, text) => sendHookFeedback(r.api, "loop-hook", text), "followUp"],
	["wake retry (wake.retry)", (r, text) => sendWakeRetry(r.api, "loop-retry", text, 1, "overloaded"), "followUp"],
	["peer notice (peer.notice)", (r, text) => sendPeerNotice(r.api, "loop-peer", text), "steer"],
];

describe.each(SENDERS)("%s", (_name, send, deliverAs) => {
	it("wakes an idle session with one turn that carries the text", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("woken")]);
		await send(r, "IDLE-WAKE");
		await settled(r, 1);
		expect(count(r.requests[0], "IDLE-WAKE")).toBe(1);
	});

	it(`reaches a busy session as a ${deliverAs}: ${deliverAs === "steer" ? "inside the running turn" : "in a turn of its own after it"}`, async () => {
		const slow = blockingTool();
		const r = await rig({ tools: [slow.tool] });
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("answer"),
			r.reply("answer to the wake"),
		]);
		const running = r.harness.session.prompt("go");
		await slow.started;
		await send(r, "BUSY-WAKE");
		slow.release();
		await running;
		await settled(r, deliverAs === "steer" ? 1 : 2);
		const carrying = r.requests.findIndex((request) => count(request, "BUSY-WAKE") > 0);
		expect(carrying).toBe(deliverAs === "steer" ? 0 : 1);
	});
});

const result = (id: string) => ({ id, profile: "worker", outcome: "completed", status: "completed" });
const report = (id: string, wake: boolean) =>
	({ content: `REPORT-${id}`, details: result(id), wake, reportId: id }) as never;

describe("a child's report (subagents/handoff/wake.ts:10)", () => {
	it("starts the turn with the last send of a batch, so two reports are one turn (together)", async () => {
		// `new` delivers reports through the loop's window, which this pins wide enough for both sends.
		const r = await rig({ settings: { runtime: { eventWindowSeconds: 0.3 } } });
		r.harness.setResponses([r.reply("read both"), r.reply("must not be consumed")]);
		void sendAgentReport(r.api, report("a", true), {}, undefined, false);
		await sendAgentReport(r.api, report("b", true), {}, undefined, true);
		await settled(r, 1);
		expect(count(r.requests[0], "REPORT-a")).toBe(1);
		expect(count(r.requests[0], "REPORT-b")).toBe(1);
		expect(r.harness.getPendingResponseCount()).toBe(1);
	});

	it("is read at the parent's next turn, without waking it, when the report asks for no wake", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("later")]);
		await sendAgentReport(r.api, report("quiet", false), {}, undefined, false);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(0);
		await r.harness.session.prompt("anything new?");
		expect(count(r.requests[0], "REPORT-quiet")).toBe(1);
	});

	it("waits as a follow-up while the parent runs", async () => {
		const slow = blockingTool();
		const r = await rig({ tools: [slow.tool] });
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("answer"),
			r.reply("answer to the report"),
		]);
		const running = r.harness.session.prompt("go");
		await slow.started;
		await sendAgentReport(r.api, report("late", true), {}, undefined, true);
		slow.release();
		await running;
		await settled(r, 2);
		expect(count(r.requests[0], "REPORT-late")).toBe(0);
		expect(count(r.requests[1], "REPORT-late")).toBe(1);
	});
});

const hot = (at: number): MachineSample => ({
	at,
	load1: 48,
	load5: 30,
	load15: 30,
	cores: 12,
	memTotal: 100,
	memAvailable: 50,
	swapUsed: 0,
	swapTotal: 0,
	gpu: null,
	processes: [{ pid: 1, ppid: 0, command: "tsc", cpu: 900, rss: 1, owner: "owner-title" }],
});

/** The machine publisher files its alerts in the database (R11), so the rig gives it a real one. */
let machineDb: ReturnType<typeof openAgentDb>["db"];
async function monitored(title: string) {
	const opened = openAgentDb(path.join(tmp(), "machine.db"));
	machineDb = opened.db;
	afterEachClose.push(() => opened.close());
	let sampler: MachineSamplerOptions | undefined;
	const r = await rig({
		register: (api) =>
			registerMonitor(api, {
				isSubagent: false,
				jobs: () => [],
				notify: () => undefined,
				db: () => machineDb,
				title: () => title,
				watch: new StuckJobWatch({ logSize: () => 0, groupCpu: async () => new Map() }),
				start: (options) => {
					sampler = options;
					return { tick: async () => undefined, stop: () => undefined };
				},
			}),
		settings: { monitor: { samples: 1 } },
	});
	if (!sampler) throw new Error("the monitor did not start sampling");
	return { r, sampler };
}

describe("a monitor alert (monitor/register.ts:131)", () => {
	it("wakes the session that owns the cause with one turn, alert text included", async () => {
		const { r, sampler } = await monitored("owner-title");
		r.harness.setResponses([r.reply("looked at the load")]);
		sampler.onSample(hot(60_000), true);
		await settled(r, 1);
		expect(count(r.requests[0], "tsc 900% CPU")).toBe(1);
	});

	it("leaves a session that does not own the cause a hidden note and starts no turn", async () => {
		const { r, sampler } = await monitored("someone-else");
		r.harness.setResponses([r.reply("must not be consumed")]);
		sampler.onSample(hot(60_000), true);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(0);
		await r.harness.session.prompt("status?");
		expect(count(r.requests[0], "tsc 900% CPU")).toBe(1);
	});
});
