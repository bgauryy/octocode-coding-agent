import type { QueuedInput } from "../../../core/agent-session.ts";
import type { RpcCommandBody } from "./types.ts";

type QueueData = {
	get_queue: { items: QueuedInput[] };
	edit_queued: { outcome: "replaced" | "removed" | "missing" };
	remove_queued: { removed: boolean };
	move_queued: { moved: boolean };
};

/** Queued-message commands over RPC: list, edit, remove and move, addressed by queue id. */
export function createQueueClient(call: <T>(command: RpcCommandBody) => Promise<T>) {
	return {
		list: async () => (await call<QueueData["get_queue"]>({ type: "get_queue" })).items,
		edit: async (queueId: string, text: string) =>
			(await call<QueueData["edit_queued"]>({ type: "edit_queued", queueId, text })).outcome,
		remove: async (queueId: string) =>
			(await call<QueueData["remove_queued"]>({ type: "remove_queued", queueId })).removed,
		move: async (queueId: string, direction: "up" | "down") =>
			(await call<QueueData["move_queued"]>({ type: "move_queued", queueId, direction })).moved,
	};
}
