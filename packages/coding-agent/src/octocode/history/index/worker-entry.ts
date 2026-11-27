/**
 * The archive-index worker's program, from source; the Node bundle ships it built on its own as
 * `archive-index-worker.js` (`client.ts`), so the worker loads the index code, not the whole bundle.
 */
import { parentPort, workerData } from "node:worker_threads";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { IndexCancelled, type IndexRequest, IndexService } from "./service.ts";

const port = parentPort!;
const service = new IndexService((workerData as { file: string }).file, { yields: false });
port.on("message", (message: { id: number; request: IndexRequest } | { close: true }) => {
	if ("close" in message) {
		void service.close().then(() => port.close());
		return;
	}
	service.run(message.request).then(
		(scored) => port.postMessage({ id: message.id, ok: true, scored }),
		(error: unknown) =>
			port.postMessage({
				id: message.id,
				ok: false,
				cancelled: error instanceof IndexCancelled,
				error: errorMessage(error),
			}),
	);
});
port.postMessage({ ready: true });
