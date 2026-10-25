import { methods } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { FakeWorker, harness } from "./acp-test-harness.ts";

it("counts an announced startup once and releases only its own failed slot", async () => {
	const first = new FakeWorker();
	const second = new FakeWorker();
	const blocked = Promise.withResolvers<void>();
	const firstId = (await first.getState()).sessionId;
	first.start.mockImplementationOnce(async () => {
		first.identify(firstId);
		await blocked.promise;
		throw new Error("late startup failure");
	});
	let index = 0;
	const h = harness({ maxSessions: 2, createWorker: async () => [first, second, new FakeWorker()][index++] });
	await h.initialize();
	const starting = expect(h.newSession()).rejects.toThrow("Could not start");
	await expect.poll(() => first.start.mock.calls.length).toBe(1);
	const ready = await h.newSession();
	await expect(h.newSession()).rejects.toThrow("Session limit");
	await expect(h.prompt(firstId)).rejects.toThrow("busy");
	blocked.resolve();
	await starting;
	expect(first.stop).toHaveBeenCalledOnce();
	expect(second.stop).not.toHaveBeenCalled();
	second.prompt.mockImplementationOnce(async () => "handled");
	await expect(h.prompt(ready.sessionId)).resolves.toEqual({ stopReason: "end_turn" });
	await expect(h.newSession()).resolves.toHaveProperty("sessionId");
});

it("does not remove another session when a worker announces its existing identity", async () => {
	const first = new FakeWorker();
	const second = new FakeWorker();
	const id = (await first.getState()).sessionId;
	second.start.mockImplementationOnce(async () => second.identify(id));
	let index = 0;
	const h = harness({ createWorker: async () => [first, second][index++] });
	await h.initialize();
	await h.newSession();
	await expect(h.newSession()).rejects.toThrow();
	expect(second.stop).toHaveBeenCalledOnce();
	expect(first.stop).not.toHaveBeenCalled();
	first.prompt.mockImplementationOnce(async () => "handled");
	await expect(h.prompt(id)).resolves.toEqual({ stopReason: "end_turn" });
});

it("rejects a changed final identity without leaking startup output", async () => {
	const worker = new FakeWorker();
	worker.start.mockImplementationOnce(async () => {
		worker.identify("wrong-identity");
		worker.emit({ type: "session_dispatch", active: true, dispatchId: "startup" });
	});
	const h = harness({ createWorker: async () => worker });
	await h.initialize();
	await expect(h.newSession()).rejects.toThrow("Native session identity changed");
	expect(worker.stop).toHaveBeenCalledOnce();
	await expect(
		h.connection.agent.request(methods.agent.session.close, { sessionId: "wrong-identity" }),
	).rejects.toThrow();
});
