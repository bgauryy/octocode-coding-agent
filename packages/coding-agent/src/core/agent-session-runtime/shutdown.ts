import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionServices } from "../agent-session-services.ts";
import type { SessionShutdownEvent } from "../features/index.ts";
import { emitSessionShutdownEvent } from "../features/runner.ts";
import { sessionMirrorSettled } from "../session-manager/mirror.ts";

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
		await session.abort(event.reason === "quit" ? "shutdown" : "replacement");
	} catch (error) {
		errors.push(error);
	}
	try {
		await emitSessionShutdownEvent(session.extensionRunner, event);
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
			// Bound final mirror draining; an interrupted mirror is repaired on the next open.
			await sessionMirrorSettled(1_500);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Session shutdown failed");
}
