import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { isRecord } from "../../../utils/guards.ts";
import { AGENT_ID_ENV } from "../store/env.ts";

/** The session entry (`api.appendEntry`, never sent to the model) that records the team name a top-level session joined as. */
export const TEAM_ENTRY = "octocode-team";
/** A name as `agentName` draws them; anything else in a session file (edited, foreign) is not claimed. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The name a starting session rejoins the team as: the latest one its branch recorded. Startup (`--continue`, `--session`),
 * reload and resume continue the same session, so peers keep addressing it by that name; a new or forked session is a
 * new identity and joins on its first team action, as before.
 */
export function teamNameToResume(
	entries: readonly SessionEntry[],
	reason: "startup" | "reload" | "new" | "resume" | "fork" | undefined,
): string | undefined {
	if (reason === "new" || reason === "fork") return undefined;
	const entry = entries.findLast((item) => item.type === "custom" && item.customType === TEAM_ENTRY);
	const data = entry?.type === "custom" ? entry.data : undefined;
	return isRecord(data) && data.version === 1 && typeof data.id === "string" && NAME.test(data.id)
		? data.id
		: undefined;
}

/**
 * A top-level session's team name: the one to claim first when joining, and the record written when it changes. A
 * subagent's name is its parent's choice (`AGENT_ID_ENV`), so a subagent neither claims nor records one here.
 */
export class SessionTeamName {
	private last: string | undefined;
	private readonly api: Pick<ExtensionAPI, "appendEntry">;
	private readonly env: NodeJS.ProcessEnv;
	constructor(api: Pick<ExtensionAPI, "appendEntry">, env: NodeJS.ProcessEnv) {
		this.api = api;
		this.env = env;
	}

	/** A session starts with the name it recorded (`teamNameToResume`), if any; whether it should rejoin now. */
	start(name: string | undefined): boolean {
		this.last = this.env[AGENT_ID_ENV] ? undefined : name;
		return this.last !== undefined;
	}

	/** The name to claim before drawing a new one. */
	get preferred(): string | undefined {
		return this.last;
	}

	/** A top-level session joined as `id`: record it once, so a resume finds it (a taken name was replaced by a fresh one). */
	joined(id: string): void {
		if (this.env[AGENT_ID_ENV] || id === this.last) return;
		this.last = id;
		this.api.appendEntry(TEAM_ENTRY, { version: 1, id });
	}
}
