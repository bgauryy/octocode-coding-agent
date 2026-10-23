import { methods } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { deferred, harness } from "./acp-test-harness.ts";

describe("ACP session lifecycle", () => {
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
