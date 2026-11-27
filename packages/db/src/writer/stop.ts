import type { Worker } from "node:worker_threads";
import type { DbWriterMessage } from "./protocol.ts";

/** An active archive releases its lock before termination; otherwise stop immediately. Workers stay unref'd. */
export function stopDbWriter(worker: Worker | undefined, stopping: Int32Array): void {
	if (!worker) return;
	if (Atomics.exchange(stopping, 0, 2) !== 1) {
		void worker.terminate().catch(() => undefined);
		return;
	}
	worker.on("message", (message: DbWriterMessage) => {
		if (message.type === "stopped") void worker.terminate().catch(() => undefined);
	});
}
