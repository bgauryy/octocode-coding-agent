import type { CommandContext } from "../../core/features/index.ts";
import type { SessionInfo } from "../../core/session-manager.ts";
import { liveActivityOf } from "../activity/session-activity.ts";
import { listingScope, quickList } from "../sessions/catalog.ts";
import type { SessionExtra, SessionIndex } from "../sessions/store.ts";
import { liveProcess } from "../shared/process.ts";
import type { PlaceSession } from "./model.ts";

/**
 * One catalogued session as `/realm` shows it: live from its row's pid, and for another live session the light its
 * process wrote (this session's own state is the screen the place is shown on).
 */
export function placeSession(
	info: Pick<SessionInfo, "id" | "name" | "cwd" | "modified" | "path">,
	extra: SessionExtra | undefined,
	currentId: string,
	root: string,
): PlaceSession {
	const current = info.id === currentId;
	const activity = current ? undefined : liveActivityOf(extra);
	return {
		id: info.id,
		...(info.name ? { name: info.name } : {}),
		cwd: info.cwd || root,
		modified: info.modified.getTime(),
		live: current || liveProcess(extra?.pid, extra?.pid_started),
		...(activity ? { activity } : {}),
		current,
		file: info.path,
	};
}

/** Where `/realm` reads sessions: those started in each of `roots`, the current one included. */
export type SessionSource = (roots: readonly string[], ctx: CommandContext) => Promise<PlaceSession[]>;

/**
 * The sessions Octocode saved for each folder, from the session catalog (the list `/resume` shows), with liveness from the
 * session table. `index` throws when the agent database cannot be opened.
 */
export function catalogSessions(index: () => SessionIndex): SessionSource {
	return async (roots, ctx) => {
		const db = index();
		const currentId = ctx.sessionManager.getSessionId();
		const found = new Map<string, PlaceSession>();
		for (const root of roots) {
			const infos = await quickList(db, listingScope(ctx.sessionManager, root, false));
			const extras = db.extras(infos.map((info) => info.id));
			for (const info of infos) found.set(info.id, placeSession(info, extras.get(info.id), currentId, root));
		}
		// A session has no file before its first reply.
		if (!found.has(currentId))
			found.set(currentId, {
				id: currentId,
				cwd: ctx.cwd,
				modified: Date.now(),
				live: true,
				current: true,
				file: ctx.sessionManager.getSessionFile() ?? "",
			});
		return [...found.values()];
	};
}
