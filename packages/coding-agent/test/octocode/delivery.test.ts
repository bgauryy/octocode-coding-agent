import { describe, expect, it, vi } from "vitest";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { Mail } from "../../src/octocode/team/mail.ts";
import { Delivery } from "../../src/octocode/ui/delivery.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";

function setup(mode = "tui") {
	const fake = fakePi();
	const delivery = Delivery.install(fake.pi);
	const ctx = fakeCtx({ cwd: "/x", mode });
	return { ...fake, delivery, ctx };
}

const report = (id: string) => ({
	customType: "octocode-agent-report",
	content: `report ${id}`,
	display: true,
	details: { id },
});

describe("Delivery", () => {
	it("propagates synchronous throws and asynchronous rejection to a composed team-mail caller", async () => {
		const fake = fakePi();
		const rejected = vi.fn();
		vi.spyOn(fake.pi, "sendMessage").mockRejectedValueOnce(new Error("host rejected"));
		Delivery.install(fake.pi);
		const mail = new Mail(fake.pi);
		expect(mail.notice("failure notice", rejected)).toBe(true);
		await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
		const throws = fakePi();
		vi.spyOn(throws.pi, "sendMessage").mockImplementationOnce(() => {
			throw new Error("not ready");
		});
		Delivery.install(throws.pi);
		expect(() => throws.pi.sendMessage(report("sync"))).toThrow("not ready");
	});
	it("preserves an asynchronous host rejection for callers and removes its queued ledger entry", async () => {
		const fake = fakePi();
		vi.spyOn(fake.pi, "sendMessage").mockRejectedValueOnce(new Error("host rejected"));
		const delivery = Delivery.install(fake.pi);
		const ctx = fakeCtx({ cwd: "/x", mode: "tui" });
		await fake.emit("session_start", {}, ctx);
		await fake.emit("agent_start", {}, ctx);
		await expect(fake.pi.sendMessage(report("rejected"), { deliverAs: "steer" })).rejects.toThrow("host rejected");
		expect(delivery.pending).toBe(0);
		await fake.emit("agent_settled", {}, ctx);
		expect(fake.sent).toHaveLength(0);
		expect(ctx.ui.notes).toEqual([]);
	});

	it("waits for queued host acceptance and reports asynchronous re-append failure accurately", async () => {
		const fake = fakePi();
		let accept!: () => void;
		const first = new Promise<void>((resolve) => {
			accept = resolve;
		});
		vi.spyOn(fake.pi, "sendMessage").mockReturnValueOnce(first).mockRejectedValueOnce(new Error("append rejected"));
		const delivery = Delivery.install(fake.pi);
		const ctx = fakeCtx({ cwd: "/x", mode: "tui" });
		await fake.emit("session_start", {}, ctx);
		await fake.emit("agent_start", {}, ctx);
		const accepted = fake.pi.sendMessage(report("delayed"), { deliverAs: "steer" });
		expect(delivery.pending).toBe(1);
		const settling = fake.emit("agent_settled", {}, ctx);
		await Promise.resolve();
		expect(ctx.ui.notes).toEqual([]);
		accept();
		await accepted;
		await settling;
		expect(ctx.ui.notes).toEqual([
			{ message: expect.stringContaining("Interrupt lost 1 queued message"), type: "warning" },
		]);
	});

	it("does not re-append into a new session after a pending handoff settles", async () => {
		const fake = fakePi();
		let accept!: () => void;
		const first = new Promise<void>((resolve) => {
			accept = resolve;
		});
		const send = vi.spyOn(fake.pi, "sendMessage").mockReturnValueOnce(first);
		Delivery.install(fake.pi);
		const old = fakeCtx({ cwd: "/x", mode: "tui" });
		await fake.emit("session_start", {}, old);
		await fake.emit("agent_start", {}, old);
		const handoff = fake.pi.sendMessage(report("old"), { deliverAs: "steer" });
		const settling = fake.emit("agent_settled", {}, old);
		await fake.emit("session_start", {}, fakeCtx({ cwd: "/x", mode: "tui" }));
		accept();
		await handoff;
		await settling;
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("paints the new session on start, so a status left on its UI is cleared and the replaced one is not touched", async () => {
		const t = setup();
		await t.emit("session_start", {}, t.ctx);
		await t.emit("agent_start", {}, t.ctx);
		t.pi.sendMessage(report("a"), { deliverAs: "steer" });
		expect(t.ctx.ui.statuses.get(STATUS.queued)).toContain("1 queued");
		const next = fakeCtx({ cwd: "/x", mode: "tui" });
		next.ui.setStatus(STATUS.queued, "stale");
		await t.emit("session_start", {}, next);
		expect(next.ui.statuses.get(STATUS.queued)).toBeUndefined();
		expect(t.ctx.ui.statuses.get(STATUS.queued)).toContain("1 queued");
		expect(t.delivery.pending).toBe(0);
	});

	it("passes every message through and tracks only those a run queues", async () => {
		const t = setup();
		await t.emit("session_start", {}, t.ctx);
		// Idle: Octocode appends or starts a turn right away; nothing waits.
		t.pi.sendMessage(report("idle"), { triggerTurn: true });
		expect(t.delivery.pending).toBe(0);
		await t.emit("agent_start", {}, t.ctx);
		t.pi.sendMessage(report("a"), { triggerTurn: true, deliverAs: "followUp" });
		t.pi.sendMessage(report("b"), { deliverAs: "steer" });
		// Held by Octocode until the turn ends, never cleared; next-turn messages wait for the user; no details, no identity.
		t.pi.sendMessage(report("fyi"), { triggerTurn: false });
		t.pi.sendMessage(report("later"), { deliverAs: "nextTurn" });
		t.pi.sendMessage({ customType: "x", content: "plain", display: true, details: undefined }, { deliverAs: "steer" });
		expect(t.sent).toHaveLength(6);
		expect(t.delivery.pending).toBe(2);
		expect(t.ctx.ui.statuses.get(STATUS.queued)).toContain("2 queued");

		// Octocode starts the queued messages: the same details objects come back on message_start.
		for (const entry of t.sent.slice(1, 3))
			await t.emit("message_start", { message: { role: "custom", ...entry.message } }, t.ctx);
		expect(t.delivery.pending).toBe(0);
		expect(t.ctx.ui.statuses.get(STATUS.queued)).toBeUndefined();
		await t.emit("agent_settled", {}, t.ctx);
		expect(t.sent).toHaveLength(6);
		expect(t.ctx.ui.notes).toEqual([]);
	});

	it("tracks a message queued while a run prepares, before agent_start", async () => {
		const fake = fakePi();
		const delivery = Delivery.install(fake.pi);
		let idle = true;
		const ctx = fakeCtx({ cwd: "/x", mode: "tui" });
		(ctx as { isIdle: () => boolean }).isIdle = () => idle;
		await fake.emit("session_start", {}, ctx);
		// Octocode is running before_agent_start handlers: it queues the report, but agent_start has not fired.
		idle = false;
		fake.pi.sendMessage(report("early"), { triggerTurn: true, deliverAs: "followUp" });
		expect(delivery.pending).toBe(1);
		await fake.emit("agent_start", {}, ctx);
		// Esc cleared Octocode's queue: the report is added back, not lost.
		await fake.emit("agent_settled", {}, ctx);
		expect(fake.sent.at(-1)).toEqual({
			message: expect.objectContaining({ content: "report early" }),
			options: { triggerTurn: false },
		});
	});

	it("re-appends messages an interrupt cleared, without starting a turn", async () => {
		const t = setup();
		await t.emit("session_start", {}, t.ctx);
		await t.emit("agent_start", {}, t.ctx);
		const queued = report("a");
		t.pi.sendMessage(queued, { triggerTurn: true, deliverAs: "followUp" });
		t.pi.sendMessage(report("b"), { deliverAs: "steer" });
		// A look-alike message (another details object) does not count as delivery.
		await t.emit("message_start", { message: { role: "custom", ...report("a") } }, t.ctx);
		await t.emit("message_start", { message: { role: "user", content: "hi" } }, t.ctx);
		expect(t.delivery.pending).toBe(2);
		// Esc: Octocode cleared its queue and the run settles without starting them.
		await t.emit("agent_settled", {}, t.ctx);
		expect(t.sent.slice(2)).toEqual([
			{ message: queued, options: { triggerTurn: false } },
			{ message: expect.objectContaining({ content: "report b" }), options: { triggerTurn: false } },
		]);
		expect(t.ctx.ui.notes).toEqual([{ message: expect.stringContaining("kept 2 queued messages"), type: "info" }]);
		expect(t.delivery.pending).toBe(0);
		// Re-appended at idle: not tracked again.
		await t.emit("agent_settled", {}, t.ctx);
		expect(t.sent).toHaveLength(4);
	});

	it("leaves the queue alone outside the TUI and forgets messages of an ended session", async () => {
		const t = setup("rpc");
		await t.emit("session_start", {}, t.ctx);
		await t.emit("agent_start", {}, t.ctx);
		t.pi.sendMessage(report("a"), { deliverAs: "steer" });
		await t.emit("agent_settled", {}, t.ctx);
		// RPC abort keeps Octocode's queue: the next run starts the message, so re-sending would duplicate it.
		expect(t.sent).toHaveLength(1);
		expect(t.delivery.pending).toBe(0);

		const tui = setup();
		await tui.emit("session_start", {}, tui.ctx);
		await tui.emit("agent_start", {}, tui.ctx);
		tui.pi.sendMessage(report("a"), { deliverAs: "steer" });
		await tui.emit("session_shutdown", {}, tui.ctx);
		expect(tui.delivery.pending).toBe(0);
		expect(tui.ctx.ui.statuses.get(STATUS.queued)).toBeUndefined();
	});

	it("counts the messages it could not re-add and says they were lost", async () => {
		const t = setup();
		await t.emit("session_start", {}, t.ctx);
		await t.emit("agent_start", {}, t.ctx);
		t.pi.sendMessage(report("a"), { deliverAs: "steer" });
		t.sent.push = () => {
			throw new Error("stale");
		};
		await t.emit("agent_settled", {}, t.ctx);
		expect(t.ctx.ui.notes).toEqual([
			{ message: "Interrupt lost 1 queued message: could not add it to the conversation (stale).", type: "warning" },
		]);
		expect(t.delivery.pending).toBe(0);
	});

	it("reports kept and lost messages separately when only some re-adds fail", async () => {
		const t = setup();
		await t.emit("session_start", {}, t.ctx);
		await t.emit("agent_start", {}, t.ctx);
		t.pi.sendMessage(report("a"), { deliverAs: "steer" });
		t.pi.sendMessage(report("b"), { deliverAs: "steer" });
		t.pi.sendMessage(report("c"), { deliverAs: "steer" });
		const push = t.sent.push.bind(t.sent);
		t.sent.push = (entry) => {
			if (String(entry.message.content).includes("report b")) throw new Error("closed");
			return push(entry);
		};
		await t.emit("agent_settled", {}, t.ctx);
		// The three queued sends, then the re-adds: `report b` throws and is not recorded.
		expect(t.sent.map((entry) => entry.message.content)).toEqual([
			"report a",
			"report b",
			"report c",
			"report a",
			"report c",
		]);
		expect(t.ctx.ui.notes).toEqual([
			{ message: expect.stringContaining("kept 2 queued messages"), type: "info" },
			{
				message: "Interrupt lost 1 queued message: could not add it to the conversation (closed).",
				type: "warning",
			},
		]);
	});

	it("stays quiet about the interrupt when the session already ended and its UI is gone", async () => {
		const t = setup();
		await t.emit("session_start", {}, t.ctx);
		await t.emit("agent_start", {}, t.ctx);
		t.pi.sendMessage(report("a"), { deliverAs: "steer" });
		t.sent.push = () => {
			throw new Error("stale");
		};
		t.ctx.ui.notify = () => {
			throw new Error("stale ctx");
		};
		await expect(t.emit("agent_settled", {}, t.ctx)).resolves.not.toThrow();
	});
});
