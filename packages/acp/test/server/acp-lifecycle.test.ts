import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AcpSession } from "../../src/server/session.ts";
import { assistant, deferred, FakeWorker, harness } from "./acp-test-harness.ts";

describe("ACP session lifecycle", () => {
	it("keeps observed work busy through dispatch and output drain, then accepts one follow-up", async () => {
		const flushed = deferred<void>();
		const notify = vi
			.fn()
			.mockImplementationOnce(() => flushed.promise)
			.mockResolvedValue(undefined);
		const worker = new FakeWorker();
		const session = new AcpSession("session", worker, { notify } as unknown as AgentContext, 5000);
		try {
			worker.emit({ type: "session_dispatch", active: true, dispatchId: "external" });
			worker.emit({ type: "message_end", message: assistant("external reply", "aborted") });
			const cancelling = session.cancel();
			await expect.poll(() => notify.mock.calls.length).toBe(1);
			expect(() => session.prompt([{ type: "text", text: "before dispatch drained" }])).toThrow(
				"Session is busy; nothing was sent.",
			);
			worker.emit({ type: "session_dispatch", active: false, dispatchId: "external" });
			expect(() => session.prompt([{ type: "text", text: "before output drained" }])).toThrow(
				"Session is busy; nothing was sent.",
			);
			expect(worker.prompt).not.toHaveBeenCalled();
			flushed.resolve();
			await cancelling;
			expect(session.isBusy()).toBe(false);
			const next = session.prompt([{ type: "text", text: "after cancellation settled" }]);
			worker.finish("next reply");
			await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
			expect(worker.prompt).toHaveBeenCalledOnce();
			expect(worker.stop).not.toHaveBeenCalled();
		} finally {
			flushed.resolve();
			await session.close();
		}
	});

	it("finishes an old observed turn's cancellation after its output flush while a new observed turn waits", async () => {
		const firstWrite = deferred<void>();
		const secondWrite = deferred<void>();
		const notify = vi
			.fn()
			.mockImplementationOnce(() => firstWrite.promise)
			.mockImplementationOnce(() => secondWrite.promise);
		const worker = new FakeWorker();
		const session = new AcpSession("session", worker, { notify } as unknown as AgentContext, 5000);
		try {
			worker.emit({ type: "session_dispatch", active: true, dispatchId: "first" });
			worker.finish("first reply");
			worker.emit({ type: "session_dispatch", active: false, dispatchId: "first" });
			await expect.poll(() => notify.mock.calls.length).toBe(1);
			let cancelled = false;
			const cancelling = session.cancel().then(() => {
				cancelled = true;
			});
			worker.emit({ type: "session_dispatch", active: true, dispatchId: "second" });
			worker.finish("second reply");
			worker.emit({ type: "session_dispatch", active: false, dispatchId: "second" });
			firstWrite.resolve();
			await expect.poll(() => cancelled).toBe(true);
			await cancelling;
			expect(notify).toHaveBeenCalledTimes(2);
			expect(worker.stop).not.toHaveBeenCalled();
			expect(() => session.prompt([{ type: "text", text: "while second output pending" }])).toThrow("Session is busy");
			secondWrite.resolve();
		} finally {
			firstWrite.resolve();
			secondWrite.resolve();
			await session.close();
		}
	});

	it("preserves autonomous output when the worker refuses a prompt after concurrent native work starts", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.prompt.mockImplementationOnce(async () => {
			worker.emit({ type: "session_dispatch", active: true, dispatchId: "native" });
			throw Object.assign(new Error("Session is busy"), { execution: "not-sent" });
		});
		await expect(h.prompt(sessionId)).rejects.toThrow("Session is busy; nothing was sent.");
		worker.finish("native first");
		await expect(h.prompt(sessionId)).rejects.toThrow("Session is busy; nothing was sent.");
		worker.emit({ type: "message_start", message: assistant("") });
		worker.finish("native follow-up");
		worker.emit({ type: "session_dispatch", active: false, dispatchId: "native" });
		await expect
			.poll(() => h.updates.filter(({ update }) => update.sessionUpdate === "agent_message_chunk").length)
			.toBe(2);
		expect(worker.stop).not.toHaveBeenCalled();
		const next = h.prompt(sessionId);
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("client reply");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("keeps a cancelled preflight reserved until it settles, then accepts another prompt without replacing the worker", async () => {
		const h = harness({ cancelTimeoutMs: 5000 });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const preflight = Promise.withResolvers<never>();
		worker.prompt.mockImplementationOnce(() => preflight.promise);
		worker.abort.mockResolvedValueOnce(undefined);
		const first = h.prompt(sessionId);
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		await h.cancel(sessionId);
		await expect.poll(() => worker.abort.mock.calls.length).toBe(1);
		await expect(h.prompt(sessionId)).rejects.toThrow("Session already has an active prompt");
		preflight.reject(new Error("Prompt dispatch cancelled"));
		await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
		expect(worker.stop).not.toHaveBeenCalled();
		const next = h.prompt(sessionId);
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("next reply");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("cancels a closing session, rejects new work while stopping, and releases its capacity after stop", async () => {
		const h = harness({ maxSessions: 1 });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		const stopped = deferred<void>();
		h.workers[0].stop.mockImplementationOnce(() => stopped.promise);
		const closing = h.connection.agent.request(methods.agent.session.close, { sessionId });
		await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
		await expect.poll(() => h.workers[0].stop.mock.calls.length).toBe(1);
		await expect(h.prompt(sessionId)).rejects.toThrow();
		await expect(h.newSession()).rejects.toThrow("Session limit reached");
		stopped.resolve();
		await expect(closing).resolves.toEqual({});
		await expect(h.prompt(sessionId)).rejects.toThrow();
		await expect(h.newSession()).resolves.toHaveProperty("sessionId");
		expect(h.workers[0].stop).toHaveBeenCalledOnce();
		expect(h.workers[1].start).toHaveBeenCalledOnce();
	});

	it("does not let an old cancellation deadline stop a later prompt while its abort acknowledgement is delayed", async () => {
		const h = harness({ cancelTimeoutMs: 100 });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const acknowledgement = deferred<void>();
		h.workers[0].abort.mockImplementationOnce(() => acknowledgement.promise);
		const first = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		await h.cancel(sessionId);
		await expect.poll(() => h.workers[0].abort.mock.calls.length).toBe(1);
		h.workers[0].finish("first");
		await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
		const second = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(h.workers[0].stop).not.toHaveBeenCalled();
		acknowledgement.resolve();
		h.workers[0].finish("second");
		await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });
	});
});
