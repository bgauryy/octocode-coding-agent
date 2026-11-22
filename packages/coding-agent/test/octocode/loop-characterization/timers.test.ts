import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { tmp } from "../helpers.ts";
import { blockingTool, count, createRig, type Rig } from "./rig.ts";

/**
 * `notify` timers through a real session (RFC agent-event-loop R0, §4): a due timer wakes as `{ triggerTurn: true, deliverAs:
 * "steer" }` (timer/register.ts:225), so an idle session starts a turn with the note and a busy one reads it at its next
 * request. The timer survives only through the agent database. R3/R5 move timers onto a `timer.due` topic.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

async function timed(tools: Parameters<typeof createRig>[0] = {}) {
	const db = path.join(tmp(), "octocode.db");
	const rig = await createRig({
		...tools,
		register: (api) =>
			registerTimers(api, {
				reservation: () => undefined,
				agent: () => undefined,
				env: { ...process.env, OCTOCODE_AGENT_DB: db },
			}),
	});
	rigs.push(rig);
	return rig;
}

const setTimer = (note: string, after = 1) =>
	fauxAssistantMessage(fauxToolCall("notify", { op: "set", after, note, reason: "characterize" }), {
		stopReason: "toolUse",
	});

describe("a due notify timer", () => {
	it("starts a turn of an idle session, carrying its note, after the turn that set it ended", async () => {
		const r = await timed();
		r.harness.setResponses([setTimer("TIMER-NOTE"), fauxAssistantMessage("timer set"), r.reply("woken by the timer")]);
		await r.harness.session.prompt("remind me");
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(0);
		await vi.waitFor(() => expect(r.requests).toHaveLength(1), { timeout: 15_000 });
		await r.harness.session.waitForIdle();
		expect(count(r.requests[0], "Note: TIMER-NOTE")).toBe(1);
	});

	it("is a steer while the session is busy: the next request of the running turn carries it", async () => {
		const slow = blockingTool();
		const r = await timed({ tools: [slow.tool] });
		r.harness.setResponses([
			setTimer("TIMER-STEER"),
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("answer"),
			r.reply("must not be consumed"),
		]);
		const running = r.harness.session.prompt("set a timer then wait");
		await slow.started;
		await new Promise((resolve) => setTimeout(resolve, 2500));
		slow.release();
		await running;
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "Note: TIMER-STEER")).toBe(1);
		expect(count(r.requests[0], "slow-result")).toBe(1);
		expect(r.harness.getPendingResponseCount()).toBe(1);
	});
});
