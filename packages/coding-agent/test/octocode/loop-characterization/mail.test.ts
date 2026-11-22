import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mail } from "../../../src/octocode/team/mail.ts";
import type { Message } from "../../../src/octocode/team/model.ts";
import { blockingTool, branchLines, count, createRig, IN_NEW_MODE, sleep, type Rig } from "./rig.ts";
import { gateSummary } from "./summary-gate.ts";

/**
 * Team mail delivery (RFC agent-event-loop R0, §4), through the real `Mail` class and the real gate (team/mail.ts):
 * every mail is a steer (mail.ts:151 `deliverAs: "steer"`), and only a batch holding a `wake` message starts an idle
 * session's turn. An interrupt (mail.ts:126) aborts the running step and holds the mail until the run settles (`settled`).
 * R3 moves mail to `agent.message` topics; steer-versus-follow-up per producer is the behaviour R4/R5 decide on.
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

let nextId = 1;
const message = (text: string, extra: Partial<Message> = {}): Message => ({
	id: nextId++,
	from: "parent-1",
	to: "me",
	text,
	at: Date.now(),
	replyRequired: false,
	...extra,
});
const PARENT = "parent-1";
const mailOf = (r: Rig) => new Mail(r.api);

const settled = async (r: Rig, turns: number) => {
	await vi.waitFor(() => expect(r.requests).toHaveLength(turns), { timeout: 10_000 });
	await r.harness.session.waitForIdle();
};

describe("team mail", () => {
	it("a waking message starts one turn of an idle session", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("read it")]);
		expect(mailOf(r).deliver([message("MAIL-WAKE", { wake: true })], PARENT, r.ctx)).toBe(true);
		await settled(r, 1);
		expect(count(r.requests[0], "MAIL-WAKE")).toBe(1);
	});

	it("a message that does not wake waits for the next turn without starting one", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("answer")]);
		mailOf(r).deliver([message("MAIL-QUIET")], PARENT, r.ctx);
		await sleep(100);
		expect(r.requests).toHaveLength(0);
		await r.harness.session.prompt("hello");
		expect(count(r.requests[0], "MAIL-QUIET")).toBe(1);
	});

	it("a batch is one message for the model, and one waking message wakes the whole batch", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("read both")]);
		mailOf(r).deliver([message("MAIL-ONE"), message("MAIL-TWO", { wake: true })], PARENT, r.ctx);
		await settled(r, 1);
		expect(count(r.requests[0], "MAIL-ONE")).toBe(1);
		expect(count(r.requests[0], "MAIL-TWO")).toBe(1);
		expect(r.requests[0].filter((line) => line.includes("MAIL-ONE") && line.includes("MAIL-TWO"))).toHaveLength(1);
	});

	it("mail to a busy session is a steer: the very next request carries it, no turn of its own", async () => {
		const slow = blockingTool();
		const r = await rig({ tools: [slow.tool] });
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("answer"),
			r.reply("must not be consumed"),
		]);
		const running = r.harness.session.prompt("go");
		await slow.started;
		mailOf(r).deliver([message("MAIL-STEER", { wake: true })], PARENT, r.ctx);
		slow.release();
		await running;
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "MAIL-STEER")).toBe(1);
		expect(count(r.requests[0], "slow-result")).toBe(1);
		expect(r.harness.getPendingResponseCount()).toBe(1);
	});
});

describe("an interrupt (team/mail.ts:126)", () => {
	it("stops the running step, holds the mail, and starts the next turn only when `settled` hands it over", async () => {
		const slow = blockingTool();
		const r = await rig({ tools: [slow.tool] });
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			r.reply("continued with the mail"),
		]);
		const mail = mailOf(r);
		const running = r.harness.session.prompt("go");
		await slow.started;
		expect(mail.deliver([message("MAIL-STOP", { interrupt: true, wake: true })], PARENT, r.ctx)).toBe(true);
		await running.catch(() => undefined);
		await r.harness.session.waitForIdle();
		// Nothing was sent: the run ended and the mail is held for the settle handoff.
		expect(r.requests).toHaveLength(0);
		expect(mail.interrupted.aborted).toBe(true);
		expect(mail.settled()).toBe(true);
		expect(mail.interrupted.aborted).toBe(false);
		await settled(r, 1);
		expect(count(r.requests[0], "MAIL-STOP")).toBe(1);
		// The stopped step's result is in the history the model sees (an aborted tool result), not silently dropped.
		expect(branchLines(r.harness).some((line) => line.startsWith("toolResult:"))).toBe(true);
	});

	it("on an idle session is an ordinary delivery: no abort, no hold", async () => {
		const r = await rig();
		r.harness.setResponses([r.reply("read it")]);
		const abort = vi.spyOn(r.ctx, "abort");
		const mail = mailOf(r);
		mail.deliver([message("MAIL-IDLE-INTERRUPT", { interrupt: true, wake: true })], PARENT, r.ctx);
		await settled(r, 1);
		expect(abort).not.toHaveBeenCalled();
		expect(mail.settled()).toBe(false);
	});

	// `new` also stops at 95% and a peer's interrupt spares a compaction (R5): compaction-stop.test.ts pins that mode.
	it.skipIf(IN_NEW_MODE)(
		"cancels a running manual compaction (run-loop.ts:354 abortCompaction): no summary is saved, the mail still arrives",
		async () => {
			const r = await rig({
				models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 100 }],
				compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
			});
			r.harness.setResponses([
				fauxAssistantMessage(`s1:${"a".repeat(1500)}`),
				fauxAssistantMessage(`s2:${"b".repeat(1500)}`),
				r.reply("continued with the mail"),
			]);
			await r.harness.session.prompt("seed 1");
			await r.harness.session.prompt("seed 2");
			const gate = gateSummary(r.harness.session);
			const mail = mailOf(r);
			const compacting = r.harness.session.compact().then(
				() => "saved",
				(error: Error) => `cancelled: ${error.message}`,
			);
			await gate.started;
			expect(r.harness.session.isCompacting).toBe(true);
			expect(r.ctx.isIdle()).toBe(false);
			mail.deliver([message("MAIL-STOP-COMPACTION", { interrupt: true, wake: true })], PARENT, r.ctx);
			const outcome = await compacting;
			expect(outcome).toMatch(/^cancelled/);
			await r.harness.session.waitForIdle();
			expect(branchLines(r.harness)).not.toContain("compaction");
			expect(r.harness.session.isCompacting).toBe(false);
			expect(r.requests).toHaveLength(0);
			expect(mail.settled()).toBe(true);
			await settled(r, 1);
			expect(count(r.requests[0], "MAIL-STOP-COMPACTION")).toBe(1);
			expect(branchLines(r.harness)).not.toContain("compaction");
		},
	);
});
