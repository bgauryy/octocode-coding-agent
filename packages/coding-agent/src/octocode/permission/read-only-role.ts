import path from "node:path";
import { AGENT_SCRATCH_ENV, READ_ONLY_ENV, SUBAGENT_ENV, envFlag } from "../shared/env.ts";
import { mutatedPaths } from "../shared/file-input.ts";
import { resolveToolPath, workspacePaths } from "../shared/home.ts";
import { optionalString } from "../shared/util.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { readOnlyCommand } from "./shell/read-only.ts";
import { shellMutation } from "./shell/mutation.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../shared/home/repo.ts";

/**
 * The permission-layer half of a `readOnly: true` profile (reviewer, researcher, browser): the child's prompt says to
 * investigate and report, and this refuses what would change the repository whatever mode the session is in. It
 * allows a write to the child's scratch folder (`OCTOCODE_AGENT_SCRATCH`), to `.octocode/tmp/` and to Markdown docs under
 * `.octocode/` (not `.octocode/skills/`, which later sessions load): a task names its output path only in its text, so
 * the guard cannot know it, and the documented destinations are `.octocode/<topic>/*.md`. For shell commands it
 * refuses what the parse shows as a change inside the workspace (`shell/mutation.ts`); it is not a sandbox, so a
 * program that writes by itself (`node script.js`) is not seen.
 */

/** Whether this process is a read-only subagent: the parent set the flag from the profile; a session that merely inherits it is not one. */
export const readOnlyRole = (env: NodeJS.ProcessEnv = process.env): boolean =>
	envFlag(env, SUBAGENT_ENV) && envFlag(env, READ_ONLY_ENV);

/** Whether a read-only child may write `file`: its scratch folder, `.octocode/tmp/`, or a Markdown doc under `.octocode/`. */
function mayWrite(file: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
	const target = canonicalPath(resolveToolPath(cwd, file));
	const scratch = env[AGENT_SCRATCH_ENV];
	if (scratch && isWithin(target, canonicalPath(scratch))) return true;
	const { dir, tmp, skills } = workspacePaths(cwd);
	if (isWithin(target, canonicalPath(tmp))) return true;
	return target.endsWith(".md") && isWithin(target, canonicalPath(dir)) && !isWithin(target, canonicalPath(skills));
}

const refusal = (what: string): string =>
	`${what} is refused: this is a read-only role. Investigate and report; write only your scratch folder, \`.octocode/tmp/\` or a Markdown doc under \`.octocode/\`.`;

/** The refusal for a call a read-only child must not make, or undefined when it may (or this is not a read-only child). */
export function readOnlyRoleRefusal(
	event: { toolName: string; input: unknown },
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!readOnlyRole(env)) return undefined;
	const input = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>;
	if (event.toolName === "debug" && input.action !== "terminate")
		return refusal("Debugging (the adapter can execute code)");
	if (event.toolName === "file" || event.toolName === "edit" || event.toolName === "write") {
		const files = mutatedPaths(event.toolName, input);
		if (event.toolName === "file" && files.length === 0 && (input.patch !== undefined || input.queries !== undefined))
			return refusal("A file change that names no readable path");
		const outside = files.find((file) => !mayWrite(file, cwd, env));
		return outside === undefined ? undefined : refusal(`Changing ${outside}`);
	}
	if (!SHELL_TOOLS.has(event.toolName)) return undefined;
	const command = optionalString(input.command) ?? "";
	if (event.toolName === "powershell" || input.type === "powershell")
		return readOnlyCommand(command) ? undefined : refusal("This PowerShell command (its effects cannot be parsed)");
	const effect = shellMutation(command);
	const root = workspaceRoot(cwd) ?? path.resolve(cwd);
	const changed = effect.writes.find((file) => {
		const target = canonicalPath(resolveToolPath(cwd, file));
		return isWithin(target, canonicalPath(root)) && !mayWrite(file, cwd, env);
	});
	if (changed !== undefined) return refusal(`Changing ${changed} from the shell`);
	if (effect.opaque.length > 0) return refusal(`\`${effect.opaque[0]}\``);
	if (effect.uncertain) return refusal("A shell command that writes to a path it does not spell out");
	return undefined;
}
