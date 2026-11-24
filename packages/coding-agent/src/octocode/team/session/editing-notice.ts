import { renderPrompt } from "../../../core/prompt-template.ts";
import { dbFailure } from "../routing.ts";
import type { ReservationHost } from "./reservations.ts";

/**
 * The line naming another live session that declared `absolute` as one it edits, or undefined. It refuses nothing and
 * joins nobody: a session that never joined, or whose team database is unusable (a solo session keeps editing then, as in
 * `reservationText`), has no one to compare with. One lookup on the `leases_path` index.
 */
export function editingNotice(host: ReservationHost, absolute: string, display: string): string | undefined {
	const me = host.me();
	if (!me) return undefined;
	const store = host.existing();
	if (!store) return undefined;
	const other = store.editing.other(absolute, me.id);
	if (!other) return undefined;
	const who = other.sessionId ? `${other.owner} (session ${other.sessionId})` : other.owner;
	return renderPrompt("notices/peer/concurrent-edit.md", {
		file: display,
		who,
		paths: other.paths.join(", "),
	}).trim();
}

/**
 * Records that this session changed `absolute` (a lease of the team's table, same expiry as a reservation). Called after
 * a change landed: a refused or failed edit leaves nothing. A session that never joined records nothing; a database
 * error comes back as one line, since the landed change must not be reported as failed.
 */
export function declareEditing(host: ReservationHost, absolute: string): string | undefined {
	const me = host.me();
	if (!me) return undefined;
	try {
		host.store().editing.declare(me.id, absolute);
		return undefined;
	} catch (error) {
		return `Could not record that this session edits ${absolute}: ${dbFailure(error)}.`;
	}
}
