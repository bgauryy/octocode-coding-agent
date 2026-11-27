import fsp from "node:fs/promises";
import { readSessionHeaderForDiscovery } from "../../../core/session-manager/storage.ts";
import { pendingReportsDir } from "./pending.ts";

export interface StartNote {
	text: string;
	level: "info" | "warning";
}

/**
 * A session that replaces another in this process (`/new`, `/worktree switch`, `/resume`) stops the old session's background
 * children, and their reports are saved with the OLD session (`pending.ts`), where only that session's next start takes them.
 * They are not delivered here: the new conversation never asked for that work, and a report claimed by the wrong session
 * would leave the one that did without it. This says where they are, once, as the new session starts. Resolves to undefined
 * when nothing is saved (or the session was not replaced), and never rejects.
 */
export async function stoppedChildrenNotice(
	event: { reason: string; previousSessionFile?: string },
	currentSessionId: string,
	env?: NodeJS.ProcessEnv,
): Promise<StartNote | undefined> {
	if ((event.reason !== "new" && event.reason !== "resume") || !event.previousSessionFile) return undefined;
	const previous = readSessionHeaderForDiscovery(event.previousSessionFile)?.id;
	if (!previous || previous === currentSessionId) return undefined;
	try {
		const saved = (await fsp.readdir(pendingReportsDir(previous, env))).filter((name) => name.endsWith(".json"));
		const count = saved.length;
		if (count === 0) return undefined;
		return {
			text: `${count} background agent report${count === 1 ? " is" : "s are"} saved with session ${previous}; /resume it to read them`,
			level: "info",
		};
	} catch {
		// No pending folder: the old session had nothing to save.
		return undefined;
	}
}
