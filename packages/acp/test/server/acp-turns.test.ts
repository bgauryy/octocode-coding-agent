import { describe, expect, it } from "vitest";
import { assistant, harness } from "./acp-test-harness.ts";

/**
 * Characterization of the ACP turn paths the unified agent event loop (RFC agent-event-loop R10) must keep: a client
 * prompt is one turn that ends with the worker's settle, a second prompt is refused while one runs, cancel ends the turn
 * as `cancelled` and frees the session, and work the worker starts on its own (a wake: observed turn) streams as updates,
 * keeps the session busy until it ends, and then lets a prompt through.
 */

const messageChunks = (updates: ReturnType<typeof harness>["updates"]) =>
	updates.filter(({ update }) => update.sessionUpdate === "agent_message_chunk");

describe("ACP prompt, cancel and observed turns", () => {
	it("a prompt resolves end_turn when the worker settles, streaming the reply as a message chunk", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const turn = h.prompt(sessionId, "hi");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		expect(worker.prompt.mock.calls[0][0]).toBe("hi");
		worker.emit({ type: "message_start", message: assistant("") });
		worker.finish("the answer");
		await expect(turn).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(JSON.stringify(messageChunks(h.updates))).toContain("the answer");
	});

	it("refuses a second prompt while one runs, without sending it, and accepts one after the turn ends", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const first = h.prompt(sessionId, "first");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		await expect(h.prompt(sessionId, "second")).rejects.toThrow("Session already has an active prompt");
		expect(worker.prompt).toHaveBeenCalledOnce();
		worker.finish("one");
		await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
		const next = h.prompt(sessionId, "third");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("two");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("cancel aborts the worker and ends the running prompt as cancelled; the session takes a new prompt, same worker", async () => {
		const h = harness({ cancelTimeoutMs: 5000 });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const first = h.prompt(sessionId, "long task");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		await h.cancel(sessionId);
		await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
		expect(worker.abort).toHaveBeenCalledOnce();
		expect(worker.stop).not.toHaveBeenCalled();
		const next = h.prompt(sessionId, "again");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("fine");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("an observed turn (worker-started, no client prompt) streams its reply and holds the session busy until it ends", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.emit({ type: "session_dispatch", active: true, dispatchId: "wake" });
		worker.emit({ type: "message_start", message: assistant("") });
		worker.finish("woken reply");
		await expect.poll(() => messageChunks(h.updates).length).toBe(1);
		expect(JSON.stringify(messageChunks(h.updates))).toContain("woken reply");
		await expect(h.prompt(sessionId, "during")).rejects.toThrow("Session is busy; nothing was sent.");
		expect(worker.prompt).not.toHaveBeenCalled();
		worker.emit({ type: "session_dispatch", active: false, dispatchId: "wake" });
		const next = h.prompt(sessionId, "after");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		worker.finish("client reply");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("cancel during an observed turn aborts the worker's run and frees the session", async () => {
		const h = harness({ cancelTimeoutMs: 5000 });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.emit({ type: "session_dispatch", active: true, dispatchId: "wake" });
		await h.cancel(sessionId);
		await expect.poll(() => worker.abort.mock.calls.length).toBe(1);
		worker.emit({ type: "session_dispatch", active: false, dispatchId: "wake" });
		const next = h.prompt(sessionId, "after cancel");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		worker.finish("ok");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(worker.stop).not.toHaveBeenCalled();
	});
});
