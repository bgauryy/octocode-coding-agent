import { memoryMutation } from "../shared/archive-operation.ts";
import os from "node:os";
import path from "node:path";
import { AGENT_SCRATCH_ENV, READ_ONLY_ENV, SUBAGENT_ENV, envFlag } from "@octocodeai/octocode-common/env";
import { toolEffect } from "./tool-effects.ts";
import { resolveToolPath, workspacePaths } from "../shared/home.ts";
import { optionalString } from "../shared/util.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { readOnlyCommand } from "./shell/read-only.ts";
import { joiningCd } from "./bash-cwd.ts";
import { shellMutation } from "./shell/mutation.ts";
import { roleExecChange } from "./shell/role-exec.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { workspaceRoot } from "../../utils/git-repository.ts";
import { shellPath } from "./file-access.ts";
import { loadedFromAgentDir } from "./later-session-loaded.ts";
import { AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import { browserEscalations } from "./browser-escalation.ts";
import { browserMcpTool } from "@octocodeai/octocode-common/browser-mcp";
import { DESKTOP_SERVER, isMcpToolName, mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { mcpCallChange } from "./mcp-reads.ts";

/**
 * The permission-layer half of a `readOnly: true` profile (reviewer, researcher, browser): the child's prompt says to
 * investigate and report, and this refuses what would change the repository whatever mode the session is in. It
 * allows a write to the child's scratch folder (`OCTOCODE_AGENT_SCRATCH`), to `.octocode/agent/temp/`, to the throwaway folder
 * `.octocode/agent/tmp/` and to Markdown docs under `.octocode/agent/` except its state, checkouts and `MEMORY.md`
 * (`loadedFromAgentDir`): a task names its output path only in its text, so the guard cannot know
 * it, and the documented destinations are `.octocode/agent/<topic>/*.md`. For shell commands it
 * refuses what the parse shows as a change anywhere but the temporary folders (`shell/mutation.ts`), programs
 * that write or run code through their options or change remote state (`shell/role-exec.ts`: `gh pr merge`, `man -P`), and any git call
 * but a listed read (`shell/git-forms.ts`), and any `octocode` run (the product starts a session without these limits); it is
 * not a sandbox, so a program that writes by itself (`node script.js`) is not seen. Any other MCP tool runs only when a
 * trusted server entry declares it read-only (`mcp-reads.ts`). A browser MCP call that leaves the isolated browser
 * (the real profile, another program as the browser, download CDP, an upload from outside the workspace;
 * `browser-escalation.ts`) is refused too, though the profile may grant `browser.control` for the package's own tools.
 * Cookie access, by CDP or the `cookies` tool, is not refused: it is a `browser.cookies` ask that reaches the user.
 */

/** Whether this process is a read-only subagent: the parent set the flag from the profile; a session that merely inherits it is not one. */
export const readOnlyRole = (env: NodeJS.ProcessEnv = process.env): boolean =>
	envFlag(env, SUBAGENT_ENV) && envFlag(env, READ_ONLY_ENV);

/**
 * Whether a read-only child may write `target` (canonical): its scratch folder, `.octocode/agent/temp/`, the workspace's
 * throwaway folder `.octocode/agent/tmp/` (`agentTmpDir`, which retention expires), a topic's `.octocode/agent/<topic>/tmp/`,
 * or a Markdown doc under `.octocode/agent/` outside its state, checkouts and `MEMORY.md`.
 */
export function mayWrite(target: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
	const scratch = env[AGENT_SCRATCH_ENV];
	if (scratch && canonicalPath(scratch) === scratch && isWithin(target, scratch)) return true;
	const { agent, temp } = workspacePaths(cwd);
	if (canonicalPath(temp) === temp && isWithin(target, temp))
		return !isWithin(target.toLowerCase(), path.join(temp, "sessions").toLowerCase());
	if (canonicalPath(agent) !== agent || !isWithin(target, agent)) return false;
	const [entry = "", second] = path.relative(canonicalPath(agent), target).split(path.sep);
	if (loadedFromAgentDir(entry)) return false;
	// Throwaway files go in `.octocode/agent/tmp/`; a skill keeps its run scratch (ledgers, probes) in `.octocode/agent/<topic>/tmp/`.
	if (entry.toLowerCase() === AGENT_FOLDERS.tmp || second?.toLowerCase() === AGENT_FOLDERS.tmp) return true;
	return target.toLowerCase().endsWith(".md");
}

/**
 * Whether a read-only child may create the directory `target` (canonical) with `mkdir`: one it may write, or one it may
 * write a Markdown doc into, which the `file` tool would create anyway. No new authority: the folder's contents stay
 * under `mayWrite`.
 */
const mayCreateDirectory = (target: string, cwd: string, env: NodeJS.ProcessEnv): boolean =>
	mayWrite(target, cwd, env) || mayWrite(path.join(target, "notes.md"), cwd, env);

/**
 * Whether a write lands in the home folder: its dotfiles and tool settings run in later sessions (`~/.zshrc`,
 * `~/.claude/settings.json`), which is the same reach as a hook in the repository. The temporary folder stays writable
 * even where it lives under home (`TMPDIR=~/tmp`).
 */
const underHome = (target: string): boolean =>
	isWithin(target, canonicalPath(os.homedir())) && !isWithin(target, canonicalPath(os.tmpdir()));

/** Where a read-only child may write outside the workspace and home: the temporary folders and devices (`/dev/null`). */
const throwawayOutside = (target: string): boolean =>
	[os.tmpdir(), "/tmp", "/var/tmp", "/dev"].some((dir) => isWithin(target, canonicalPath(dir)));

const refusal = (what: string): string =>
	`${what} is refused: this is a read-only role. Investigate and report; write only your scratch folder, \`.octocode/agent/temp/\`, \`.octocode/agent/tmp/\`, a topic's \`.octocode/agent/<topic>/tmp/\` or a Markdown doc under \`.octocode/agent/\` (not its state, \`worktrees/\` or \`MEMORY.md\`). The file tool creates missing folders.`;

/** The refusal for a call a read-only child must not make, or undefined when it may (or this is not a read-only child). */
export function readOnlyRoleRefusal(
	event: { toolName: string; input: unknown },
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!readOnlyRole(env)) return undefined;
	const input = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>;
	if (event.toolName === "memory" && memoryMutation(input)) return refusal("Saving shared memory");
	// The role lists items; it reports follow-ups and its coordinator files them.
	if (event.toolName === "backlogPlan" && input.op !== "list" && input.op !== "stat")
		return refusal("Filing or editing backlog items");
	if (browserMcpTool(event.toolName) !== undefined) {
		const { control, outside } = browserEscalations(event.toolName, input, cwd);
		const first =
			control[0] ?? (outside[0] === undefined ? undefined : `Uploading ${outside[0]} from outside the workspace`);
		return first === undefined ? undefined : refusal(first);
	}
	// The desktop server's calls leave the repository alone: the `desktop.control` ask the profile declares decides them.
	if (event.toolName.startsWith(`${mcpNamespace(DESKTOP_SERVER)}__`)) return undefined;
	if (isMcpToolName(event.toolName)) {
		const change = mcpCallChange(event.toolName);
		return change === undefined ? undefined : refusal(`${event.toolName} (${change})`);
	}
	const declared = toolEffect(event.toolName);
	if (declared?.kind === "write") {
		const changes = declared.changes?.(input);
		if (changes === undefined) return refusal("A change that names no readable path");
		const outside = changes.find((change) => !mayWrite(canonicalPath(resolveToolPath(cwd, change.path)), cwd, env));
		return outside === undefined ? undefined : refusal(`Changing ${outside.path}`);
	}
	// A tool that runs programs the guard cannot parse, or changes things no argument names, is refused here.
	if ((declared?.kind === "opaque" || declared?.kind === "exec") && !SHELL_TOOLS.has(event.toolName))
		return refusal(`${event.toolName} (a tool whose effect cannot be checked)`);
	if (!SHELL_TOOLS.has(event.toolName)) return undefined;
	const command = optionalString(input.command) ?? "";
	if (input.type === "powershell")
		return readOnlyCommand(command, "powershell")
			? undefined
			: refusal("This PowerShell command (its effects cannot be parsed)");
	const exec = roleExecChange(command);
	if (exec !== undefined) return refusal(`\`${exec}\``);
	const effect = shellMutation(command);
	const root = workspaceRoot(cwd) ?? path.resolve(cwd);
	const directories = new Set(effect.directories);
	// A database `sqlite3` opens for writing is a write too.
	const changed = [...effect.writes, ...effect.databases].find((file) => {
		const target = canonicalPath(shellPath(cwd, file));
		// Outside the workspace and home only the temporary folders are throwaway: a sibling repository is someone's work.
		if (!isWithin(target, canonicalPath(root)) && !underHome(target)) return !throwawayOutside(target);
		return directories.has(file) ? !mayCreateDirectory(target, cwd, env) : !mayWrite(target, cwd, env);
	});
	if (changed !== undefined) {
		const joined = effect.afterUnjoinedCd && !path.isAbsolute(changed) ? joiningCd(command) : undefined;
		// Offer the rewrite only when the guard accepts it as written.
		const accepted =
			joined !== undefined &&
			joined !== command &&
			readOnlyRoleRefusal({ toolName: event.toolName, input: { ...input, command: joined } }, cwd, env) === undefined;
		const hint =
			joined === undefined
				? ""
				: " (a `cd` joined by `;` or a newline may have failed, leaving it here: join it with `&&`)";
		return refusal(`Changing ${changed} from the shell${hint}`) + (accepted ? ` Run exactly: ${joined}` : "");
	}
	if (effect.opaque.length > 0)
		return refusal(
			`\`${effect.opaque[0]}\` (${effect.opaque[0] === "octocode" ? "it starts a session of its own, without this role's limits; " : ""}an opaque command: it changes files or repository state without naming a path, so its effect cannot be checked; use the declared read tools, or give your coordinator the exact command and mark what it would settle as unverified)`,
		);
	if (effect.unread.length > 0)
		return refusal(
			`\`${effect.unread[0]}\` (this role's git is status, log, diff, show, blame, grep, ls-files, ls-tree, rev-parse, rev-list, describe, shortlog, cat-file and show-ref, and branch, tag, remote, stash, worktree and notes when they only list; without \`-c\`, \`--git-dir\` or \`--work-tree\`)`,
		);
	if (effect.afterDirectoryChange)
		return refusal(
			"A write to a relative path after a `cd` the guard cannot follow (it follows only `cd /abs/dir` or `cd ./dir` joined by `&&`: not a bare name, `..`, a variable, `cd -`, `||` or a loop); write with absolute paths or use `cd /absolute/dir && …`",
		);
	if (effect.programSwap) return refusal(`A command that may run a program it does not name: ${effect.programSwap}`);
	if (effect.uncertain)
		return refusal(
			`A shell write whose target the guard cannot resolve${effect.uncertainBecause ? `: ${effect.uncertainBecause}` : ""}; spell the path out`,
		);
	if (effect.awkUnread)
		return refusal(
			`An awk call outside the allowlist this role reads (${effect.awkUnread}); read with \`rg\` or \`jq\``,
		);
	return undefined;
}
