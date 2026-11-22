import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_PEER_TYPE } from "../../../src/octocode/backlog/peer-notify.ts";
import { SETTINGS_DEFAULTS } from "../../../src/core/settings-defaults.ts";
import type { AgentEvent } from "../../../src/octocode/wake/catalog.ts";
import { blockingTool, count, createRig, sleep, wakeGateOf, wakeRows, type Rig } from "./rig.ts";

/**
 * Characterization of the wake gate in a real session (RFC agent-event-loop R0, §4). Every case pins what the code does
 * today; a comment names the R-item that changes it on purpose.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});
async function rig(options: Parameters<typeof createRig>[0] = {}) {
	const made = await createRig(options);
	rigs.push(made);
	return made;
}

const exit = (job: string): AgentEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });
/** A topic the gate still delivers in every mode; a job exit is the loop's with `runtime.eventLoop: new` (R6). */
const ended = (agent: string): AgentEvent => ({ kind: "agent.ended", agent, reason: "done" });
const message = (text: string) => ({ customType: "loop-test", content: text, display: true });
const wake = { triggerTurn: true, deliverAs: "followUp" as const, together: true };

describe("the wake gate with the default hold window", () => {
	it("defaults the hold window to 0 (setting subagents.wakeHoldSeconds) — R4 replaces it with a 2 s window", () => {
		expect(SETTINGS_DEFAULTS.subagents.wakeHoldSeconds).toBe(0);
	});

	it("wakes an idle session at once, in one turn that carries the message (no hold)", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("woken")]);
		await wakeGateOf(r.api).emit(exit("bash-1"), message("WAKE-A"), wake);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "WAKE-A")).toBe(1);
	});

	it("costs two turns for two wakes sent back to back while idle (N events, N turns) — R4 merges them", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("first"), r.reply("second")]);
		const gate = wakeGateOf(r.api);
		const first = gate.emit(exit("bash-1"), message("WAKE-A"), wake);
		const second = gate.emit(exit("bash-2"), message("WAKE-B"), wake);
		await Promise.all([first, second]);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(2);
		expect(count(r.requests[0], "WAKE-A")).toBe(1);
		expect(count(r.requests[0], "WAKE-B")).toBe(0);
		expect(count(r.requests[1], "WAKE-B")).toBe(1);
	});

	it("draws no wake row without a UI (the harness has none)", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("woken")]);
		await wakeGateOf(r.api).emit(exit("bash-1"), message("WAKE-A"), wake);
		await r.harness.session.waitForIdle();
		expect(wakeRows(r.harness)).toEqual([]);
	});

	it("merges wakes arriving inside a configured window into one turn, only while idle", async () => {
		// The gate's own hold (`old`, `shadow`) and the loop's window (`new`, for the topics it delivers: a child's end is one).
		const r = await rig({ settings: { subagents: { wakeHoldSeconds: 0.15 }, runtime: { eventWindowSeconds: 0.15 } } });
		r.harness.setResponses([r.reply("merged"), r.reply("never used")]);
		const gate = wakeGateOf(r.api);
		const first = gate.emit(ended("child-1"), message("WAKE-A"), wake);
		await sleep(30);
		const second = gate.emit(ended("child-2"), message("WAKE-B"), wake);
		// Held: nothing has reached the session yet.
		expect(r.requests).toHaveLength(0);
		await Promise.all([first, second]);
		await vi.waitFor(() => expect(r.requests).toHaveLength(1), { timeout: 10_000 });
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "WAKE-A")).toBe(1);
		expect(count(r.requests[0], "WAKE-B")).toBe(1);
		expect(r.harness.getPendingResponseCount()).toBe(1);
	});

	it("never holds a wake that arrives while a run is in progress, even with a window set", async () => {
		const slow = blockingTool();
		const r = await rig({ tools: [slow.tool], settings: { subagents: { wakeHoldSeconds: 5 } } });
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("after the steer"),
		]);
		const running = r.harness.session.prompt("go");
		await slow.started;
		const began = Date.now();
		await wakeGateOf(r.api).emit(exit("bash-1"), message("WAKE-STEER"), {
			triggerTurn: true,
			deliverAs: "steer",
		});
		expect(Date.now() - began).toBeLessThan(1000);
		slow.release();
		await running;
		await r.harness.session.waitForIdle();
		// The steer joined the run: the next request after the tool result carries it.
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "WAKE-STEER")).toBe(1);
		expect(count(r.requests[0], "slow-result")).toBe(1);
	});

	it("delivers a follow-up wake that arrives mid-run as a turn of its own after the run", async () => {
		const slow = blockingTool();
		const r = await rig({ tools: [slow.tool] });
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
		await vi.waitFor(() => expect(r.requests).toHaveLength(2));
		await r.harness.session.waitForIdle();
		// Not in the request that answers the tool result; in the next one, after the first answer.
		expect(count(r.requests[0], "WAKE-FOLLOW")).toBe(0);
		expect(count(r.requests[1], "WAKE-FOLLOW")).toBe(1);
	});
});

describe("a backlog peer wake (compose-backlog.ts:23-28)", () => {
	it("is a hidden follow-up: an idle session answers it with one turn that carries the fact", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("looked at the peer change")]);
		await wakeGateOf(r.api).emit(
			{ kind: "item.peer", ref: "B2", change: "closed", by: "agent-a", relation: "dependent", id: 7 },
			{ customType: BACKLOG_PEER_TYPE, content: "PEER-FACT B2 closed", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "PEER-FACT B2 closed")).toBe(1);
		expect(
			r.harness.session.messages.filter((m) => m.role === "custom" && m.customType === BACKLOG_PEER_TYPE),
		).toMatchObject([{ display: false }]);
	});
});
