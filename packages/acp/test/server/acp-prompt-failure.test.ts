import { describe, expect, it } from "vitest";
import { harness } from "./acp-test-harness.ts";

/** The shape RpcClient throws when the worker answers `success: false`: the response's own `execution` field, here absent. */
function commandError(message: string): Error {
	return Object.assign(new Error(message), { execution: undefined });
}

describe("ACP prompt failures", () => {
	it("reports missing credentials as ACP's typed auth-required error and keeps the session usable", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.prompt.mockRejectedValueOnce(
			Object.assign(commandError("No API key found for the selected model."), { authRequired: true }),
		);
		await expect(h.prompt(sessionId, "hello")).rejects.toMatchObject({
			code: -32000,
			message: expect.stringContaining("No API key found"),
		});
		expect(worker.stop).not.toHaveBeenCalled();
		const next = h.prompt(sessionId, "hello");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("signed in");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
	});

	it("keeps any other refusal generic", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		h.workers[0].prompt.mockRejectedValueOnce(commandError("refused"));
		await expect(h.prompt(sessionId, "hello")).rejects.toMatchObject({ code: -32603 });
	});

	it("fails only a prompt the live worker rejects and keeps the session usable", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.prompt.mockRejectedValueOnce(commandError("/context is available in the interactive terminal only."));
		await expect(h.prompt(sessionId, "/context")).rejects.toThrow(
			"/context is available in the interactive terminal only.",
		);
		expect(worker.stop).not.toHaveBeenCalled();
		const next = h.prompt(sessionId, "hello");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("still here");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(worker.stop).not.toHaveBeenCalled();
	});

	it("releases the turn when the rejection follows its dispatch events", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.prompt.mockImplementationOnce(async (_message: string) => {
			worker.emit({ type: "session_dispatch", active: true, dispatchId: "d" });
			worker.emit({ type: "session_dispatch", active: false, dispatchId: "d" });
			throw commandError("/context is available in the interactive terminal only.");
		});
		await expect(h.prompt(sessionId, "/context")).rejects.toThrow("interactive terminal only");
		const next = h.prompt(sessionId, "hello");
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(2);
		worker.finish("ok");
		await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(worker.stop).not.toHaveBeenCalled();
	});

	it("still closes the session when the worker process dies during a prompt", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const exit = new Error("Agent process exited (code=1 signal=null).");
		// RpcClient rejects pending requests, then notifies close listeners, in one synchronous step.
		worker.prompt.mockImplementationOnce(async () => {
			queueMicrotask(() => worker.fail(exit));
			throw exit;
		});
		await expect(h.prompt(sessionId)).rejects.toThrow();
		await expect(h.prompt(sessionId)).rejects.toThrow();
		expect(worker.prompt).toHaveBeenCalledOnce();
	});

	it("closes the session when the worker dies while its prompt is pending", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const first = h.prompt(sessionId);
		await expect.poll(() => worker.prompt.mock.calls.length).toBe(1);
		worker.fail();
		await expect(first).rejects.toThrow("Agent process closed");
		await expect(h.prompt(sessionId)).rejects.toThrow();
		expect(worker.prompt).toHaveBeenCalledOnce();
	});
});
