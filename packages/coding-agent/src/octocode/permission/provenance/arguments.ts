import path from "node:path";
import { browserMcpUrls } from "../../../../../common/src/browser-mcp.ts";
import { isMcpToolName } from "../../../../../common/src/mcp-names.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { canonicalPath } from "../../../../../common/src/canonical-path.ts";
import { isWithin } from "../../../../../common/src/paths.ts";
import { CONTEXT_FILE_CANDIDATES } from "../../../core/discovery/sources.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { toolEffect } from "../tool-effects.ts";
import { runsLater } from "../file-access.ts";
import { SHELL_TOOLS } from "../shell.ts";
import { isNetworkCommand } from "./network.ts";

/**
 * Files that run when invoked: scripts by extension, anything under a `bin/` or `scripts/` folder, files make, just and
 * direnv run, and CI workflows. Untrusted text written there is an action waiting to happen, so it stays a sink; any
 * other workspace file just stores it.
 */
const EXECUTABLE =
	/\.(?:sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd|command)$|(?:^|\/)(?:bin|scripts)\/|(?:^|\/)(?:makefile|gnumakefile|justfile|\.envrc)$|(?:^|\/)\.github\/workflows\//i;

/** Argument keys that are not an action: the model's own explanation of a call. */
const NOT_ACTION = new Set(["reason", "reasoning", "oldText"]);

export const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

/** The string leaves of a tool's arguments, minus keys that explain rather than act. */
export function leaves(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) leaves(item, out);
	else if (isRecord(value))
		for (const [key, item] of Object.entries(value)) if (!NOT_ACTION.has(key)) leaves(item, out);
	return out;
}

/**
 * Arguments that act: shell commands, file paths, the content of files that run or configure later sessions (or lie
 * outside the workspace), MCP calls, memory notes, a subagent's task. Content written into an ordinary workspace file is data.
 */
export function consequential(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	workspaceRoot: (cwd: string) => string | undefined,
): string[] {
	if (SHELL_TOOLS.has(toolName)) return [str(input.command) ?? ""];
	if (toolName === "externalAgent") return input.action === "connect" || input.action === "prompt" ? leaves(input) : [];
	// A task is an instruction to an agent with tools of its own.
	if (toolName === "agent") return leaves(input);
	const declared = toolEffect(toolName);
	if (declared?.kind === "write") {
		// A change whose targets the tool cannot name is all consequential, as is a whole patch.
		const changes = declared.changes?.(input);
		if (changes === undefined) return leaves(input);
		return changes.flatMap((change) =>
			storesData(change.path, cwd, workspaceRoot) ? [change.path] : leaves(change.detail ?? change.path),
		);
	}
	if (toolName === "memory") return input.op === "set" ? leaves(input) : [];
	if (isMcpToolName(toolName)) return leaves(input);
	return [];
}

const CONTEXT_FILE_NAMES = new Set(CONTEXT_FILE_CANDIDATES.map((name) => name.toLowerCase()));

/** An instruction file the resource loader reads into every later session (`AGENTS.md` in any folder, any letter case). */
const loadsAsInstructions = (file: string): boolean => CONTEXT_FILE_NAMES.has(path.basename(file).toLowerCase());

/**
 * `target` is an ordinary workspace file: inside the repository, not run or loaded by later sessions (`runsLater`, and the
 * instruction files `CONTEXT_FILE_CANDIDATES` names), not executable.
 */
function storesData(target: string, cwd: string, workspaceRoot: (cwd: string) => string | undefined): boolean {
	const workspace = workspaceRoot(cwd);
	if (workspace === undefined) return false;
	const root = canonicalPath(workspace);
	const file = canonicalPath(resolveToolPath(cwd, target));
	return (
		isWithin(file, root) &&
		!runsLater(file, root) &&
		!loadsAsInstructions(file) &&
		!EXECUTABLE.test(file.slice(root.length))
	);
}

/** Arguments that leave the machine: the web URL or search query, a browser navigation, a network command. */
export function egress(toolName: string, input: Record<string, unknown>): string[] {
	const url = str(input.url);
	if (toolName === "externalAgent" && input.action === "prompt") return [str(input.text) ?? ""];
	if (toolName === "web") return [url, str(input.query)].filter((value): value is string => value !== undefined);
	const opened = browserMcpUrls(toolName, input);
	if (opened.length > 0) return opened;
	const command = SHELL_TOOLS.has(toolName) ? str(input.command) : undefined;
	return command && isNetworkCommand(command) ? [command] : [];
}
