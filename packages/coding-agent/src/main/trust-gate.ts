import fs from "node:fs";
import path from "node:path";
import type { TrustChoice, TrustPromptInput } from "../cli/trust-prompt.ts";
import { FolderGrantRefusedError, grantFolder, refuseFolder } from "../octocode/trust/grants.ts";
import { homeFolder, refusedRoot } from "../octocode/trust/identity.ts";
import { homeFolderMessage, notTrustedExitLine, refusedFolderMessage, shown } from "../octocode/trust/messages.ts";
import { insideSessionShell, sessionShellRefusal } from "../octocode/trust/session-shell.ts";
import {
	resolveFolderTrust,
	type FolderTrust,
	type GrantSource,
	type TrustOptions,
} from "../octocode/trust/resolve.ts";

/**
 * The one place that decides whether a session may start in a folder. It runs before any project file is read, any
 * model is called or any tool exists. Only the interactive terminal can ask; every other surface fails with a message,
 * or records `--trust` as the user's grant first. A subagent never asks and never records.
 */

export type TrustSurface = "tui" | "print" | "json" | "rpc" | "acp" | "web" | "subagent" | "worktree";

export interface TrustGateInput {
	cwd: string;
	surface: TrustSurface;
	/** `--trust`: the user's grant for this folder, recorded with source `flag`. */
	trustFlag?: boolean;
	/** A session already running asks to move into `cwd`: the messages say the session stays where it is. */
	moving?: boolean;
	/** Shows the trust prompt; absent where nobody can be asked. */
	prompt?: (input: TrustPromptInput) => Promise<TrustChoice>;
	options?: TrustOptions;
}

export type TrustGateResult =
	/** `notice` is one line the caller prints: what the user should know about how the folder became trusted. */
	{ ok: true; root: string; notice?: string } | { ok: false; exitCode: number; message: string; stdout?: boolean };

/** Project files whose names the prompt may list. Existence only: nothing is opened. */
const PROJECT_FILE_NAMES = [
	"AGENTS.md",
	"CLAUDE.md",
	".octocode",
	".pi",
	".agents",
	".claude",
	".mcp.json",
	".codex",
	".cursor",
];

function projectFileNames(folder: string): string[] {
	return PROJECT_FILE_NAMES.filter((name) => {
		try {
			fs.lstatSync(path.join(folder, name));
			return true;
		} catch {
			return false;
		}
	});
}

const fail = (message: string, exitCode = 1): TrustGateResult => ({ ok: false, exitCode, message });

function notTrustedMessage(folder: string, surface: TrustSurface, moving = false): string {
	if (moving)
		return [
			`Error: ${folder} is not trusted, so Octocode did not switch to it. The current session is unchanged and nothing of that folder was read.`,
			`To trust it, run in your own terminal: octocode trust add ${folder}`,
		].join("\n");
	switch (surface) {
		case "rpc":
			return `Error: ${folder} is not trusted. The RPC server did not start.\nRun octocode trust add ${folder}, or start the server with --trust.`;
		case "subagent":
			return `Folder not trusted: ${folder}. The parent session must trust it first (/trust).`;
		case "worktree":
			return `Error: Creating a worktree needs your trust for ${folder}. Run again with --trust to record it.`;
		case "acp":
			return `Folder is not trusted: ${folder}. Run: octocode trust add ${folder}`;
		default:
			return [
				`Error: ${folder} is not trusted, so Octocode did not start here.`,
				"Nothing was read or run, and no model was called.",
				"To trust it, run octocode once in this folder and choose Trust, or run:",
				`  octocode trust add ${folder}`,
				'For a one-time CI run, add --trust: octocode -p "..." --trust',
			].join("\n");
	}
}

function unreadable(state: Extract<FolderTrust, { state: "untrusted" }>, folder: string): string {
	if (state.reason === "home" || state.reason === "filesystem-root")
		return `Error: ${homeFolderMessage(folder, state.reason)}`;
	if (state.reason === "missing-folder") return `Error: ${folder} does not exist, so Octocode did not start.`;
	return `Error: Cannot read Octocode's trust records${state.detail ? ` (${state.detail})` : ""}.\nOctocode did not start, so project files were not read. Fix the file or set OCTOCODE_AGENT_DB.`;
}

function record(
	cwd: string,
	which: "folder" | "parent" | "grandparent",
	source: GrantSource,
	surface: TrustSurface,
	options?: TrustOptions,
): TrustGateResult | undefined {
	try {
		grantFolder(cwd, which, { source, surface }, options);
		return undefined;
	} catch (error) {
		if (error instanceof FolderGrantRefusedError) return fail(`Error: ${homeFolderMessage(error.path, error.reason)}`);
		return fail(`Error: Could not record trust for ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function offers(state: FolderTrust, options?: TrustOptions): { parent?: string; grandparent?: string } {
	const home = homeFolder(options?.home);
	const offer = (folder: string): string | undefined => (refusedRoot(folder, home, "subtree") ? undefined : folder);
	const parent = path.dirname(state.path);
	const grandparent = path.dirname(parent);
	return {
		parent: parent !== state.path ? offer(parent) : undefined,
		grandparent: grandparent !== parent && parent !== state.path ? offer(grandparent) : undefined,
	};
}

/**
 * Decide whether a session may start in `cwd`. On `ok` the folder is trusted and `root` is the folder its grant is on.
 * On failure nothing was read, and the caller prints `message` and exits with `exitCode`.
 */
export async function enforceFolderTrust(input: TrustGateInput): Promise<TrustGateResult> {
	const { surface, options } = input;
	let state = resolveFolderTrust(input.cwd, options);
	const folder = state.path;
	if (state.state === "trusted") return { ok: true, root: state.root };
	if (state.state === "untrusted") return fail(unreadable(state, folder));
	if (input.trustFlag && surface !== "subagent" && surface !== "acp") {
		// A process the agent started from a session's shell is not the user typing the flag.
		if (insideSessionShell(options?.env)) return fail(`Error: ${sessionShellRefusal("record trust for --trust")}`);
		// The user typed the flag: a recorded "Do not trust" yields to it, as it would to `octocode trust add`.
		const replaced =
			state.state === "refused"
				? `Note: ${shown(state.root)} was marked "do not trust"; --trust replaced that decision with a grant for ${shown(folder)}. To undo it, run: octocode trust remove ${shown(folder)}`
				: undefined;
		const failed = record(input.cwd, "folder", "flag", surface, options);
		if (failed) return failed;
		state = resolveFolderTrust(input.cwd, options);
		return state.state === "trusted"
			? { ok: true, root: state.root, ...(replaced ? { notice: replaced } : {}) }
			: fail(notTrustedMessage(folder, surface));
	}
	if (state.state === "refused") {
		const message = refusedFolderMessage(folder);
		return {
			ok: false,
			exitCode: surface === "tui" ? 0 : 1,
			message: surface === "tui" ? message : `Error: ${message}`,
		};
	}
	if (surface !== "tui" || !input.prompt) return fail(notTrustedMessage(folder, surface, input.moving));

	const choice = await input.prompt({
		path: folder,
		...offers(state, options),
		projectFiles: projectFileNames(folder),
	});
	if (choice === "not-now" || choice === "refuse") {
		if (choice === "refuse") {
			try {
				refuseFolder(input.cwd, { source: "prompt", surface }, options);
			} catch (error) {
				return fail(`Error: Could not record the decision: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { ok: false, exitCode: 0, message: notTrustedExitLine(folder, choice) };
	}
	const failed = record(input.cwd, choice, "prompt", surface, options);
	if (failed) return failed;
	state = resolveFolderTrust(input.cwd, options);
	return state.state === "trusted" ? { ok: true, root: state.root } : fail(notTrustedMessage(folder, surface));
}
