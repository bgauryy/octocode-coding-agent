import { archiveMutation } from "../shared/archive-operation.ts";
import path from "node:path";
import { AGENT_SCRATCH_ENV, READ_ONLY_ENV, SUBAGENT_ENV, envFlag } from "../../../../common/src/env.ts";
import { mutatedPaths } from "../shared/file-input.ts";
import { resolveToolPath, workspacePaths } from "../shared/home.ts";
import { optionalString } from "../shared/util.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { readOnlyCommand } from "./shell/read-only.ts";
import { shellMutation } from "./shell/mutation.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../shared/home/repo.ts";
import { shellPath } from "./file-access.ts";
import { browserEscalations } from "./browser-escalation.ts";
import { browserMcpTool } from "../../../../common/src/browser-mcp.ts";

/**
 * The permission-layer half of a `readOnly: true` profile (reviewer, researcher, browser): the child's prompt says to
 * investigate and report, and this refuses what would change the repository whatever mode the session is in. It
 * allows a write to the child's scratch folder (`OCTOCODE_AGENT_SCRATCH`), to `.octa/code/temp/` and to Markdown docs under
 * `.octocode/` except where a later session loads the folder as configuration (`LOADED_BY_LATER_SESSIONS`: skills,
 * subagent profiles, prompts, themes, extensions, hooks, settings, system prompts): a task names its output path only in
 * its text, so the guard cannot know it, and the documented destinations are `.octocode/<topic>/*.md`. For shell commands it
 * refuses what the parse shows as a change inside the workspace (`shell/mutation.ts`); it is not a sandbox, so a
 * program that writes by itself (`node script.js`) is not seen. A browser MCP call that leaves the isolated browser
 * (the real profile, another program as the browser, cookie or download CDP, an upload from outside the workspace;
 * `browser-escalation.ts`) is refused too, though the profile may grant `browser.control` for the package's own tools.
 */

/** Whether this process is a read-only subagent: the parent set the flag from the profile; a session that merely inherits it is not one. */
export const readOnlyRole = (env: NodeJS.ProcessEnv = process.env): boolean =>
	envFlag(env, SUBAGENT_ENV) && envFlag(env, READ_ONLY_ENV);

/**
 * Entries directly under `.octocode/` that a later session loads as profiles, skills, prompts, themes, extensions,
 * hooks, settings or system prompts (project loaders in `core/` and `shared/home.ts`); compared lower-cased, because
 * the folder is read case-insensitively on macOS and Windows. A file planted there would run or steer a later session.
 */
const LOADED_BY_LATER_SESSIONS = new Set(
	[
		"skills",
		"agents",
		"prompts",
		"themes",
		"extensions",
		"npm",
		"git",
		"hooks.json",
		"settings.json",
		"system.md",
		"append_system.md",
	].map((name) => name.toLowerCase()),
);

/**
 * Whether a read-only child may write `target` (canonical): its scratch folder, `.octa/code/temp/`, a topic's
 * `.octocode/<topic>/tmp/`, or a Markdown doc under `.octocode/` outside the folders later sessions load.
 */
function mayWrite(target: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
	const scratch = env[AGENT_SCRATCH_ENV];
	if (scratch && canonicalPath(scratch) === scratch && isWithin(target, scratch)) return true;
	const { dir, tmp } = workspacePaths(cwd);
	if (canonicalPath(tmp) === tmp && isWithin(target, tmp))
		return !isWithin(target.toLowerCase(), path.join(tmp, "sessions").toLowerCase());
	if (canonicalPath(dir) !== dir || !isWithin(target, dir)) return false;
	const [entry = "", second] = path.relative(canonicalPath(dir), target).split(path.sep);
	if (LOADED_BY_LATER_SESSIONS.has(entry.toLowerCase())) return false;
	// A skill keeps its run scratch (ledgers, probes) in `.octocode/<topic>/tmp/`.
	if (second?.toLowerCase() === "tmp") return true;
	return target.toLowerCase().endsWith(".md");
}

/**
 * Whether a read-only child may create the directory `target` (canonical) with `mkdir`: one it may write, or one it may
 * write a Markdown doc into, which the `file` tool would create anyway. No new authority: the folder's contents stay
 * under `mayWrite`.
 */
const mayCreateDirectory = (target: string, cwd: string, env: NodeJS.ProcessEnv): boolean =>
	mayWrite(target, cwd, env) || mayWrite(path.join(target, "notes.md"), cwd, env);

const refusal = (what: string): string =>
	`${what} is refused: this is a read-only role. Investigate and report; write only your scratch folder, \`.octa/code/temp/\`, a topic's \`.octocode/<topic>/tmp/\` or a Markdown doc under \`.octocode/\` (not in a folder later sessions load, such as skills, agents or prompts). The file tool creates missing folders.`;

/** The refusal for a call a read-only child must not make, or undefined when it may (or this is not a read-only child). */
export function readOnlyRoleRefusal(
	event: { toolName: string; input: unknown },
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!readOnlyRole(env)) return undefined;
	const input = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>;
	if (event.toolName === "archive" && archiveMutation(input)) return refusal("Saving shared memory");
	if (browserMcpTool(event.toolName) !== undefined) {
		const { control, outside } = browserEscalations(event.toolName, input, cwd);
		const first =
			control[0] ?? (outside[0] === undefined ? undefined : `Uploading ${outside[0]} from outside the workspace`);
		return first === undefined ? undefined : refusal(first);
	}
	if (event.toolName === "file" || event.toolName === "edit" || event.toolName === "write") {
		const files = mutatedPaths(event.toolName, input);
		if (event.toolName === "file" && files.length === 0 && (input.patch !== undefined || input.queries !== undefined))
			return refusal("A file change that names no readable path");
		const outside = files.find((file) => !mayWrite(canonicalPath(resolveToolPath(cwd, file)), cwd, env));
		return outside === undefined ? undefined : refusal(`Changing ${outside}`);
	}
	if (!SHELL_TOOLS.has(event.toolName)) return undefined;
	const command = optionalString(input.command) ?? "";
	if (event.toolName === "powershell" || input.type === "powershell")
		return readOnlyCommand(command, "powershell")
			? undefined
			: refusal("This PowerShell command (its effects cannot be parsed)");
	const effect = shellMutation(command);
	const root = workspaceRoot(cwd) ?? path.resolve(cwd);
	const directories = new Set(effect.directories);
	const changed = effect.writes.find((file) => {
		const target = canonicalPath(shellPath(cwd, file));
		if (!isWithin(target, canonicalPath(root))) return false;
		return directories.has(file) ? !mayCreateDirectory(target, cwd, env) : !mayWrite(target, cwd, env);
	});
	if (changed !== undefined)
		return refusal(
			`Changing ${changed} from the shell${effect.afterUnjoinedCd && !path.isAbsolute(changed) ? " (a `cd` joined by `;` or a newline may have failed, leaving it here: join it with `&&`)" : ""}`,
		);
	if (effect.opaque.length > 0)
		return refusal(`\`${effect.opaque[0]}\` (it changes files or repository state without naming a path)`);
	if (effect.afterDirectoryChange)
		return refusal(
			"A write to a relative path after a `cd` the guard cannot follow (it follows only `cd /abs/dir` or `cd ./dir` joined by `&&`: not a bare name, `..`, a variable, `cd -`, `||` or a loop); write with absolute paths or use `cd /absolute/dir && …`",
		);
	if (effect.uncertain)
		return refusal(
			`A shell write whose target the guard cannot resolve${effect.uncertainBecause ? `: ${effect.uncertainBecause}` : ""}; spell the path out`,
		);
	return undefined;
}
