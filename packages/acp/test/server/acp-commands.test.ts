import { describe, expect, it, vi } from "vitest";
import { FakeWorker, harness } from "./acp-test-harness.ts";

describe("ACP slash commands", () => {
	it("advertises the commands a prompt can run, after the session exists", async () => {
		const worker = new FakeWorker();
		worker.getCommands = vi.fn(async () => [
			{ name: "agents", description: "List agents", argumentHint: "[tell <agent>]" },
			{ name: "plain" },
		]);
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		const { sessionId } = await h.newSession();
		await vi.waitFor(() => expect(h.updates.length).toBeGreaterThan(0));
		expect(h.updates[0]).toEqual({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "agents", description: "List agents", input: { hint: "[tell <agent>]" } },
					{ name: "plain", description: "plain" },
				],
			},
		});
	});

	it("sends nothing and keeps the session when the worker cannot list them", async () => {
		const worker = new FakeWorker();
		worker.getCommands = vi.fn(async () => {
			throw new Error("no answer");
		});
		const h = harness({ createWorker: async () => worker });
		await h.initialize();
		const { sessionId } = await h.newSession();
		await vi.waitFor(() => expect(worker.getCommands).toHaveBeenCalled());
		expect(h.updates).toEqual([]);
		expect(sessionId).toBeTruthy();
	});
});
