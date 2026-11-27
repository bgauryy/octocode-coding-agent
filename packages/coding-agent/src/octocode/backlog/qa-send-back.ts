import type { Backlog } from "./context.ts";
import type { QaSendBack } from "./qa-gate.ts";
import { runBacklog } from "./tool-run.ts";
import { oneWrite } from "./tool-support.ts";

/** The write that sends an item back after a review: a note and a state, returning the item's new version. */
export function sendBackOf(backlog: Backlog, signal?: AbortSignal): QaSendBack {
	return (ref, state, note) =>
		oneWrite(async () => {
			await backlog.store.transactionWhenReady(
				() => runBacklog(backlog, { op: "update", id: ref, state, note }, { subagent: false, word: "done" }),
				signal,
			);
			return backlog.store.get(ref)?.version;
		});
}
