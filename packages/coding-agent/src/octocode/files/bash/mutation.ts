import path from "node:path";
import { shellMutation, shellParserReady } from "../../permission/shell/mutation.ts";
import { readOnlyCommand } from "../../permission/shell/read-only.ts";
import { shellPath } from "../../permission/file-access.ts";
import { canonicalPath, isWithin } from "../../shared/home/repo.ts";
import { workspacePaths } from "../../shared/home.ts";
import { recordMutation } from "../feedback/revisions.ts";

/**
 * Whether `command` changes the workspace, as far as the shell guard's parse shows (`permission/shell/mutation.ts`): a
 * write inside the repository (scratch under `.octocode/tmp/` aside), a change with no path to name (`git commit`,
 * `sed -i`, `npm install`), or a write it could not resolve. Writes elsewhere (`/tmp`, `~`) do not count. A command whose
 * effect no parse shows (`node script.js`) is not seen, so a receipt can stay fresh after one.
 */
async function changesWorkspace(command: string, cwd: string, powershell: boolean): Promise<boolean> {
	// PowerShell is not parsed: anything that is not plainly a read may write.
	if (powershell) return !readOnlyCommand(command);
	await shellParserReady();
	const effect = shellMutation(command);
	if (effect.opaque.length > 0 || effect.uncertain) return true;
	const { root, tmp } = workspacePaths(cwd);
	const [base, scratch] = [canonicalPath(path.resolve(root)), canonicalPath(tmp)];
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
