import { randomUUID } from "node:crypto";
import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent } from "../../agent-session/types.ts";
import { queuePreview } from "./projection.ts";

/** Publish the lifecycle event an engine event maps to, if any. */
export function publishLifecycle(
	event: AgentSessionEvent,
	runId: string | undefined,
	publish: (event: ApplicationEvent) => void,
): void {
	const lifecycle = lifecycleEvent(event, runId);
	if (lifecycle) publish(lifecycle);
}

/** Translate engine lifecycle events; the application store owns their state. */
function lifecycleEvent(event: AgentSessionEvent, runId?: string): ApplicationEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { type: "run.started", runId: randomUUID() };
		case "agent_settled":
			return { type: "run.settled", runId: runId ?? "unknown", aborted: event.aborted };
		case "queue_update":
			return {
				type: "queue.changed",
				steering: queuePreview([...event.steering]),
				followUp: queuePreview([...event.followUp]),
			};
		case "compaction_start":
			return { type: "session.status", status: "compacting" };
		case "auto_retry_start":
			return { type: "session.status", status: "retrying" };
		case "compaction_end":
		case "auto_retry_end":
			return { type: "session.status", status: "idle" };
		default:
			return undefined;
	}
}
