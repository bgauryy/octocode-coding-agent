import type { ExtensionAPI } from "../../core/features/index.ts";
import { appendReadDigests, completedLocalReads, type snapshotLocalReads } from "../shared/local-reads.ts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";

/** Credit source reads before the file guard sees them, and expose whole-source anchors to the model. */
export function registerReadReceipts(api: ExtensionAPI) {
	const snapshotsByCall = new Map<string, Awaited<ReturnType<typeof snapshotLocalReads>>>();
	api.on("tool_result", async (event, ctx) => {
		const snapshots = snapshotsByCall.get(event.toolCallId);
		snapshotsByCall.delete(event.toolCallId);
		const details = asRecord(event.details);
		if (!snapshots || event.isError || details.outputTruncated || details.fullOutputPath) return;
		const reads = await completedLocalReads(snapshots, event.structuredContent, ctx.cwd, event.input);
		if (reads.length)
			return {
				content: appendReadDigests(event.content, reads, { nested: Boolean(event.parentToolCallId) }),
				details: { ...details, localReads: reads },
			};
	});
	// Rejected/invalid calls emit tool_execution_end without a tool_result hook. End precedes the
	// result hook for successful calls, so their snapshots must remain until that hook consumes them.
	api.on("tool_execution_end", (event) => {
		if (event.isError) snapshotsByCall.delete(event.toolCallId);
	});
	api.on("session_shutdown", () => snapshotsByCall.clear());
	return snapshotsByCall;
}
