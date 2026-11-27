import { randomUUID } from "node:crypto";
import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent } from "../../agent-session/types.ts";
import { cooldownWaitText, modelWaitText, offlineRetryText, retryText } from "../../agent-session/model-wait.ts";
import type { ApplicationRuntimeState } from "../state.ts";
import { queuePreview } from "./projection.ts";

type ShownStatus = Pick<ApplicationRuntimeState, "status" | "statusDetail" | "statusUntil">;

/**
 * The session's `status` from the causes that overlap: a compaction, a retry, a request waiting out its provider's
 * rate-limit cool-down and a quiet model request. A compaction wins, then a retry that still waits out its delay, then
 * the cool-down (shown as retrying, until it ends), then a quiet request, then a retry whose attempt is already out.
 * So a quiet request never hides a compaction or a pending retry, and when it ends the status goes back to what it was.
 */
export class SessionStatusTracker {
	private compacting = false;
	private retry: { detail: string; until: number } | undefined;
	private quiet: string | undefined;
	private cooldown: { detail: string; until: number } | undefined;

	/** Takes the status causes `event` changes; returns the status event when what `shown` says must change. */
	next(event: AgentSessionEvent, shown: ShownStatus): ApplicationEvent | undefined {
		switch (event.type) {
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				break;
			case "auto_retry_start":
				this.retry = {
					detail:
						event.offlineSince === undefined
							? retryText(event.attempt, event.maxAttempts)
							: offlineRetryText(event.attempt, event.errorMessage),
					until: Date.now() + event.delayMs,
				};
				break;
			case "auto_retry_end":
				this.retry = undefined;
				break;
			case "model_wait":
				this.quiet = event.idleMs > 0 ? modelWaitText(event.idleMs) : undefined;
				this.cooldown = event.cooldown && {
					detail: cooldownWaitText(event.cooldown.provider),
					until: event.cooldown.until,
				};
				break;
			default:
				return undefined;
		}
		const next = this.current();
		if (next.status === shown.status && next.detail === shown.statusDetail && next.until === shown.statusUntil)
			return undefined;
		return { type: "session.status", ...next };
	}

	private current(): { status: ShownStatus["status"]; detail?: string; until?: number } {
		if (this.compacting) return { status: "compacting" };
		const retry = this.retry && { status: "retrying" as const, detail: this.retry.detail, until: this.retry.until };
		if (retry && retry.until > Date.now()) return retry;
		if (this.cooldown) return { status: "retrying", detail: this.cooldown.detail, until: this.cooldown.until };
		if (this.quiet) return { status: "stalled", detail: this.quiet };
		return retry ?? { status: "idle" };
	}
}

/** Publish the lifecycle event an engine event maps to, if any. */
export function publishLifecycle(
	event: AgentSessionEvent,
	state: ShownStatus & Pick<ApplicationRuntimeState, "runId">,
	status: SessionStatusTracker,
	publish: (event: ApplicationEvent) => void,
): void {
	const lifecycle = lifecycleEvent(event, state.runId) ?? status.next(event, state);
	if (lifecycle) publish(lifecycle);
}

/** Translate engine run and queue events; the application store owns their state. */
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
		default:
			return undefined;
	}
}
