import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { recordProblem } from "../../../core/diagnostics-log.ts";
import { sharedAgentDb } from "../../../storage/database.ts";
import { registeredWorkspace } from "../../../storage/workspace-database.ts";
import { EventSubscribers } from "../../events/subscribers.ts";
import { eventLoopMode } from "../../wake/session-signals.ts";

/** How long a hook's offset outlives its last start; a resume within it handles what was published and not yet handled. */
const OFFSET_TTL_MS = 14 * 24 * 3_600_000;

interface Held {
	sessionId: string;
	subscribers: EventSubscribers;
}

const held = new WeakMap<object, Held>();

/**
 * The session's hook subscribers when `runtime.eventLoop` is `new`; undefined in `old` and `shadow`, where internal hooks keep
 * their bus listeners. One per session: a second call in the same session returns the same one, a new session id replaces it.
 * A handler's failure is written to the problem log and the event is not handled again.
 */
export function hookSubscribersOf(
	api: Pick<FeatureSetup, "settings">,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
): EventSubscribers | undefined {
	if (eventLoopMode(api) !== "new") return undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	const current = held.get(api);
	if (current?.sessionId === sessionId) return current.subscribers;
	const agent = sharedAgentDb();
	const subscribers = new EventSubscribers(agent.db, {
		workspaceId: registeredWorkspace(ctx.cwd, agent).id,
		// A lane of its own: the loop replays the events of the session id, and these are not ones it can send.
		sessionId: `hooks:${sessionId}`,
		pid: process.pid,
		ttlMs: OFFSET_TTL_MS,
		failed: (hook, event, error) =>
			void recordProblem(`hook:${hook}`, `event ${event.seq} (${event.topic}): ${String(error)}`),
	});
	held.set(api, { sessionId, subscribers });
	return subscribers;
}

/** Closes the session's subscribers after the handler running now; a later `hookSubscribersOf` makes new ones. */
export async function closeHookSubscribers(api: object): Promise<void> {
	const current = held.get(api);
	held.delete(api);
	await current?.subscribers.close();
}
