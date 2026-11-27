import path from "node:path";
import { shellMutation, shellParserReady } from "../../permission/shell/mutation.ts";
import { readOnlyCommand } from "../../permission/shell/read-only.ts";
import { shellPath } from "../../permission/file-access.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { workspacePaths } from "../../shared/home.ts";
import { recordMutation } from "../feedback/revisions.ts";

/**
 * Whether `command` changes the workspace, as far as the shell guard's parse shows (`permission/shell/mutation.ts`): a
 * write inside the repository (scratch under `.octocode/agent/temp/` aside), a change with no path to name (`git commit`,
 * `sed -i`, `npm install`), or a write it could not resolve. Writes elsewhere (`/tmp`, `~`) do not count. A command whose
 * effect no parse shows (`node script.js`) is not seen, so a receipt can stay fresh after one.
 */
async function changesWorkspace(command: string, cwd: string, powershell: boolean): Promise<boolean> {
	await shellParserReady();
	// PowerShell is not parsed: anything that is not plainly a read may write.
	if (powershell) return !readOnlyCommand(command, "powershell");
	const effect = shellMutation(command);
	if (effect.opaque.length > 0 || effect.inlineCode.length > 0 || effect.uncertain) return true;
	const { root, temp } = workspacePaths(cwd);
	const [base, scratch] = [canonicalPath(path.resolve(root)), canonicalPath(temp)];
	return effect.writes.some((file) => {
		const target = canonicalPath(shellPath(cwd, file));
		return isWithin(target, base) && !isWithin(target, scratch);
	});
}

/** A mutating `bash` command makes every earlier verification receipt stale, as a `file` edit does. Call before the command's own receipt begins, so its writes precede its check. */
export async function recordShellMutation(
	command: string,
	cwd: string,
	sessionId: string,
	powershell = false,
): Promise<void> {
	if (await changesWorkspace(command, cwd, powershell)) recordMutation(sessionId);
}

/**
 * How a `bash` call is ordered among the calls of one assistant message: a command the shell guard's parse shows as
 * changing something (a file anywhere, a ref, a database, or an effect it cannot read) runs alone, after every earlier
 * call and before every later one, so `git add` ends before the `git commit` beside it starts; so does one that may run a
 * program it does not name (`PATH=/tmp/x cat f`). A command the parse
 * shows no change for runs alongside the others. Synchronous: before the parser has loaded, a command reads as
 * unparsed and runs alone, the order that cannot race.
 */
export function bashConcurrency(args: Record<string, unknown>): "shared" | "exclusive" {
	const command = typeof args.command === "string" ? args.command : "";
	if (args.type === "powershell") return readOnlyCommand(command, "powershell") ? "shared" : "exclusive";
	const effect = shellMutation(command);
	const changes =
		effect.uncertain ||
		effect.unparsed ||
		effect.opaque.length > 0 ||
		effect.inlineCode.length > 0 ||
		effect.programSwap !== undefined ||
		effect.writes.length > 0 ||
		effect.directories.length > 0 ||
		effect.areas.length > 0 ||
		effect.refMoves.length > 0 ||
		effect.databases.length > 0;
	return changes ? "exclusive" : "shared";
}
