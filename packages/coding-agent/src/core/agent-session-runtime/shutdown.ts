import { historyArchivesSettled } from "../../../../db/src/api.ts";
import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionServices } from "../agent-session-services.ts";
import type { SessionShutdownEvent } from "../features/index.ts";
import { emitSessionShutdownEvent } from "../features/runner.ts";
import { sessionMirrorSettled } from "../session-manager/mirror.ts";

/** Longest shutdown waits for an aborted run to settle; a tool or hook that ignores abort must not block exit. */
const SHUTDOWN_ABORT_TIMEOUT_MS = 5_000;

/** Resolves when `work` settles or after `ms`; the timer is cleared either way. A late rejection is swallowed. */
async function settleWithin(work: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
		work.catch(() => {});
	}
}

/** Complete every release phase before reporting errors. Shared writers remain owned by the process. */
export async function shutdownSession(
	session: AgentSession,
	event: SessionShutdownEvent,
	beforeInvalidate?: () => void,
	services?: AgentSessionServices,
): Promise<void> {
	const errors: unknown[] = [];
	try {
		// Persist the aborted turn, including tool results, before invalidating its session.
		await settleWithin(session.abort(event.reason === "quit" ? "shutdown" : "replacement"), SHUTDOWN_ABORT_TIMEOUT_MS);
	} catch (error) {
		errors.push(error);
	}
	try {
		await emitSessionShutdownEvent(session.featureHost, event);
	} catch (error) {
		errors.push(error);
	}
	// No event-loop yield between detaching the UI and invalidating the captured contexts.
	for (const release of [beforeInvalidate, () => session.sessionManager.retire(), () => session.dispose()]) {
		try {
			release?.();
		} catch (error) {
			errors.push(error);
		}
	}
	if (services) {
		try {
			services.dispose?.();
		} catch (error) {
			errors.push(error);
		}
		try {
			// Bound final mirror draining and the history pass the session started, together; an interrupted mirror is
			// repaired on the next open, an interrupted pass retried.
			await Promise.all([sessionMirrorSettled(1_500), historyArchivesSettled(1_500)]);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Session shutdown failed");
}
