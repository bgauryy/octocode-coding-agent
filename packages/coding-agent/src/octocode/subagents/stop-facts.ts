import type { Team } from "../team/session.ts";
import type { RunDetails } from "./run-types.ts";

/** Changed files a stop report lists before it gives a count of the rest. */
const FILES_SHOWN = 20;

/** Workspace-relative files agent `id` changed since `since` (the team's edit log), newest first; none when unreadable. */
function changedFiles(team: Pick<Team, "editLog">, id: string, since: number, now = Date.now()): string[] {
	try {
		return (team.editLog()?.changes({ withinMs: now - since + 1_000, agent: id }, now) ?? []).map(
			(change) => change.path,
		);
	} catch {
		return [];
	}
}

/**
 * What a stopped run had done when it stopped, for its stop report: its last activity line and the files it changed
 * (`team/edits.ts`), so the parent can tell how far it got without opening its transcript. Empty when there is neither.
 */
export function stopFacts(details: RunDetails, team: Pick<Team, "editLog">): string {
	const last = details.activity.at(-1);
	const files = changedFiles(team, details.id, details.startedAt);
	const shown = files.slice(0, FILES_SHOWN).join(", ");
	const more = files.length > FILES_SHOWN ? ` and ${files.length - FILES_SHOWN} more` : "";
	return [
		last ? `Last activity: ${last}` : "",
		files.length > 0 ? `Changed files (${files.length}): ${shown}${more}` : "Changed files: none recorded",
	]
		.filter(Boolean)
		.map((line) => `\n${line}`)
		.join("");
}
