import { describe, expect, it, vi } from "vitest";
import { validateRpcCommand } from "../src/modes/rpc/rpc-command-schema.ts";
import { handleCommand, type RpcCommandHost } from "../src/modes/rpc/rpc-mode/commands.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";

const queued = { id: "q1", mode: "steer", text: "hello", imageCount: 0, source: "rpc" } as const;

function host() {
	const session = {
		getQueuedInputs: vi.fn(() => [queued]),
		replaceQueuedInput: vi.fn(() => "replaced"),
		removeQueuedInput: vi.fn(() => queued),
		moveQueuedInput: vi.fn(() => true),
	};
	return { session, host: { session } as unknown as RpcCommandHost };
}

describe("RPC queue commands", () => {
	it("lists, edits, removes and moves queued messages through the session owner", async () => {
		const { session, host: rpcHost } = host();
		expect(await handleCommand(rpcHost, { id: "1", type: "get_queue" })).toMatchObject({
			success: true,
			data: { items: [queued] },
		});
		expect(await handleCommand(rpcHost, { type: "edit_queued", queueId: "q1", text: "new" })).toMatchObject({
			data: { outcome: "replaced" },
		});
		expect(session.replaceQueuedInput).toHaveBeenCalledWith("q1", "new");
		expect(await handleCommand(rpcHost, { type: "remove_queued", queueId: "q1" })).toMatchObject({
			data: { removed: true },
		});
		session.removeQueuedInput.mockReturnValueOnce(undefined as never);
		expect(await handleCommand(rpcHost, { type: "remove_queued", queueId: "q1" })).toMatchObject({
			data: { removed: false },
		});
		expect(await handleCommand(rpcHost, { type: "move_queued", queueId: "q1", direction: "down" })).toMatchObject({
			data: { moved: true },
		});
		expect(session.moveQueuedInput).toHaveBeenCalledWith("q1", "down");
	});

	it("gives a Stop's withdrawn queue back in the abort response, taken before the abort", async () => {
		const order: string[] = [];
		const session = {
			clearQueue: vi.fn(() => {
				order.push("clearQueue");
				return { steering: ["guide"], followUp: ["later"] };
			}),
			abort: vi.fn(async () => {
				order.push("abort");
			}),
		};
		expect(await handleCommand({ session } as unknown as RpcCommandHost, { id: "1", type: "abort" })).toMatchObject({
			success: true,
			data: { steering: ["guide"], followUp: ["later"] },
		});
		expect(order).toEqual(["clearQueue", "abort"]);
	});

	it("validates the commands' fields", () => {
		const bad: unknown[] = [
			{ type: "edit_queued", queueId: "q1" },
			{ type: "remove_queued" },
			{ type: "move_queued", queueId: "q1", direction: "sideways" },
		];
		for (const command of bad) expect(validateRpcCommand(command)).toMatchObject({ ok: false });
		const good: RpcCommand = { type: "move_queued", queueId: "q1", direction: "up" };
		expect(validateRpcCommand(good)).toEqual({ ok: true });
	});

	it("exposes the commands on RpcClient.queue", async () => {
		const client = new RpcClient();
		const send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data: { items: [queued], outcome: "removed", removed: true, moved: false },
		}));
		(client as unknown as { send: typeof send }).send = send;
		expect(await client.queue.list()).toEqual([queued]);
		expect(await client.queue.edit("q1", " ")).toBe("removed");
		expect(await client.queue.remove("q1")).toBe(true);
		expect(await client.queue.move("q1", "up")).toBe(false);
		expect(send).toHaveBeenCalledWith({ type: "move_queued", queueId: "q1", direction: "up" });
	});
});
