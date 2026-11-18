import { agentEvents, sessions, type Db } from "../../../../db/src/api.ts";
import { sessionRunningPid } from "../shared/session-liveness.ts";

/**
 * Whether peer `name` has ended: an agent id with a recorded `delete` event, or a main session id whose `sessions`
 * row no longer names a running process (the liveness `/resume` and backlog claims use). An unknown name has not ended.
 */
export function peerEnd(db: Db, workspace: string, name: string): { reason: string; detail?: string } | undefined {
	const [event] = agentEvents.list(db, workspace, Number.MAX_SAFE_INTEGER, 1, { agentId: name, eventType: "delete" });
	if (event) {
		const { reason, detail } = event.data;
		return {
			reason: typeof reason === "string" ? reason : "ended",
			...(typeof detail === "string" ? { detail } : {}),
		};
	}
	if (sessions.pidOf(db, name) && sessionRunningPid(db, name, true) === undefined) return { reason: "session ended" };
	return undefined;
}
