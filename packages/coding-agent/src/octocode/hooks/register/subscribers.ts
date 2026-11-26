import type { FeatureContext } from "../../../core/features/index.ts";
import { recordProblem } from "../../../core/diagnostics-log.ts";
import { workspaceDbWhenReady } from "../../../storage/workspace-database.ts";
import { EventSubscribers } from "../../events/subscribers.ts";

/** How long a hook's offset outlives its last start; a resume within it handles what was published and not yet handled. */
const OFFSET_TTL_MS = 14 * 24 * 3_600_000;

interface Held {
	cwd: string;
	sessionId: string;
	subscribers: Promise<EventSubscribers>;
}

const held = new WeakMap<object, Held>();

/**
 * The session's hook subscribers. One per session: a second call in the same session returns the same one, a workspace or session switch replaces it.
 * A handler's failure is written to the problem log and the event is not handled again.
 */
export function hookSubscribersOf(
	api: object,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
): Promise<EventSubscribers> {
	const sessionId = ctx.sessionManager.getSessionId();
	const current = held.get(api);
	if (current?.sessionId === sessionId && current.cwd === ctx.cwd) return current.subscribers;
	const subscribers = workspaceDbWhenReady(ctx.cwd)
		.then(
			({ agent, workspace }) =>
				new EventSubscribers(agent, {
					workspaceId: workspace.id,
					// A lane of its own: the loop replays the events of the session id, and these are not ones it can send.
					sessionId: `hooks:${sessionId}`,
					pid: process.pid,
					ttlMs: OFFSET_TTL_MS,
					failed: (hook, event, error) =>
						void recordProblem(`hook:${hook}`, `event ${event.seq} (${event.topic}): ${String(error)}`),
				}),
		)
		.catch((error: unknown) => {
			if (held.get(api)?.subscribers === subscribers) held.delete(api);
			throw error;
		});
	held.set(api, { cwd: ctx.cwd, sessionId, subscribers });
	return subscribers;
}

/** Closes the session's subscribers after the handler running now; a later `hookSubscribersOf` makes new ones. */
export async function closeHookSubscribers(api: object): Promise<void> {
	const current = held.get(api);
	held.delete(api);
	await (await current?.subscribers)?.close();
}
