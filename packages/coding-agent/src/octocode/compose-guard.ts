import { concurrentEdits } from "./files/tool/concurrent-edit.ts";
import type { FileGuard } from "./files/tool/guard.ts";
import { changeNote } from "./team/edits.ts";
import type { Team } from "./team/session.ts";

/** What the file tool asks the team about a change: who reserves the file, who last changed it, who else edits it. */
export function connectGuard(guard: FileGuard, team: Team): void {
	guard.reservedBy = (file) => team.reservation(file, file);
	guard.modifiedBy = (file) => changeNote(team.editLog(), file, team.id);
	concurrentEdits.set(guard, {
		notice: (file, display) => team.editingNotice(file, display),
		declare: (file) => team.declareEditing(file),
	});
}
