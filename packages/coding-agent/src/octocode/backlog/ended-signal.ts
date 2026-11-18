import type { FeatureSetup } from "../../core/features/index.ts";
import { BACKLOG_ENDED_CHANNEL, type BacklogEnded } from "../shared/agent-chain.ts";

/**
 * How a write that completes an item learns what waits on it outside the board: it announces the item on the shared
 * channel (handlers run at once) and reads back the items a queued child will start by itself. Nothing listens in a
 * subagent or without queued children, and the answer is empty.
 */
export function endedSignal(api: Pick<FeatureSetup, "channels">): (ref: string) => ReadonlySet<string> {
	return (ref) => {
		const ended: BacklogEnded = { ref, queued: new Set() };
		api.channels.emit(BACKLOG_ENDED_CHANNEL, ended);
		return ended.queued;
	};
}
