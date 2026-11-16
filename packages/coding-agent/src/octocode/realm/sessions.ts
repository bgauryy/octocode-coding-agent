import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { listingScope, quickList } from "../sessions/catalog.ts";
import type { SessionIndex } from "../sessions/store.ts";
import { liveProcess } from "../shared/process.ts";
import type { RealmSession } from "./model.ts";

/** Where `/realm` reads sessions: those started in each of `roots`, the current one included. */
export type SessionSource = (roots: readonly string[], ctx: ExtensionCommandContext) => Promise<RealmSession[]>;

/**
 * The sessions Octocode saved for each folder, from the session catalog (the list `/resume` shows), with liveness from the
 * session table. `index` throws when the agent database cannot be opened.
 */
export function catalogSessions(index: () => SessionIndex): SessionSource {
	return async (roots, ctx) => {
		const db = index();
		const currentId = ctx.sessionManager.getSessionId();
		const found = new Map<string, RealmSession>();
		for (const root of roots) {
			const infos = await quickList(db, listingScope(ctx.sessionManager, root, false));
			const extras = db.extras(infos.map((info) => info.id));
			for (const info of infos) {
				const extra = extras.get(info.id);
				found.set(info.id, {
					id: info.id,
					...(info.name ? { name: info.name } : {}),
					cwd: info.cwd || root,
					modified: info.modified.getTime(),
					live: info.id === currentId || liveProcess(extra?.pid, extra?.pid_started),
					current: info.id === currentId,
					file: info.path,
				});
			}
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
