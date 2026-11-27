import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockingTool, count, createRig, type Rig } from "./rig.ts";

/**
 * Queued user input on a running session (RFC agent-event-loop R0/R10): a prompt typed during a run needs an explicit
 * behaviour (without one it is refused); a steer joins the running turn at its next model request, a follow-up waits for the
 * run to end and then gets a turn of its own; a cleared queue sends nothing.
 */

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.cleanup();
});

async function running(extra: number) {
	const slow = blockingTool();
	const r = await createRig({ tools: [slow.tool] });
	rigs.push(r);
	r.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
		r.reply("answer"),
		...Array.from({ length: extra }, (_, index) => r.reply(`queued answer ${index + 1}`)),
	]);
	const run = r.harness.session.prompt("go");
	await slow.started;
	return { r, slow, run };
}

const settled = async (r: Rig, turns: number) => {
	await vi.waitFor(() => expect(r.requests).toHaveLength(turns), { timeout: 10_000 });
	await r.harness.session.waitForIdle();
};

describe("queued input", () => {
	it("a prompt during a run without a behaviour is refused and sends nothing", async () => {
		const { r, slow, run } = await running(0);
		await expect(r.harness.session.prompt("too eager")).rejects.toThrow(/streamingBehavior/);
		slow.release();
		await run;
		await settled(r, 1);
		expect(count(r.requests[0], "too eager")).toBe(0);
	});

	it("a steer joins the running turn: the next model request of that run carries it", async () => {
		const { r, slow, run } = await running(0);
		await r.harness.session.steer("STEER-TEXT");
		expect(r.harness.session.pendingMessageCount).toBe(1);
		slow.release();
		await run;
		await settled(r, 1);
		expect(count(r.requests[0], "STEER-TEXT")).toBe(1);
		expect(r.harness.session.pendingMessageCount).toBe(0);
	});

	it("a follow-up waits for the run to end and gets a turn of its own", async () => {
		const { r, slow, run } = await running(1);
		await r.harness.session.followUp("FOLLOW-TEXT");
		expect(r.harness.session.pendingMessageCount).toBe(1);
		slow.release();
		await run;
		await settled(r, 2);
		expect(count(r.requests[0], "FOLLOW-TEXT")).toBe(0);
		expect(count(r.requests[1], "FOLLOW-TEXT")).toBe(1);
	});

	it("two follow-ups run as two turns, in order", async () => {
		const { r, slow, run } = await running(2);
		await r.harness.session.followUp("FIRST-FU");
		await r.harness.session.followUp("SECOND-FU");
		slow.release();
		await run;
		await settled(r, 3);
		expect(count(r.requests[1], "FIRST-FU")).toBe(1);
		expect(count(r.requests[1], "SECOND-FU")).toBe(0);
		expect(count(r.requests[2], "SECOND-FU")).toBe(1);
	});

	it("a cleared queue returns what was waiting and sends nothing", async () => {
		const { r, slow, run } = await running(1);
		await r.harness.session.steer("STEER-GONE");
		await r.harness.session.followUp("FU-GONE");
		expect(r.harness.session.clearQueue()).toEqual({ steering: ["STEER-GONE"], followUp: ["FU-GONE"] });
		slow.release();
		await run;
		await settled(r, 1);
		expect(count(r.requests[0], "GONE")).toBe(0);
		expect(r.harness.session.pendingMessageCount).toBe(0);
	});
});
