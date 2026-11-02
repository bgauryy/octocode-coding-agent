import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getAgentDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { allowWorktreeGrants, type WorktreeTrustRequest } from "../octocode/worktrees/approval.ts";
import { insideSessionShell, sessionShellRefusal } from "../octocode/trust/session-shell.ts";
import { describeWorktree } from "../octocode/worktrees/create.ts";
import { confirmWorktreeTrust } from "./trust-prompt.ts";
import { enterWorktree } from "../octocode/worktrees/enter.ts";
import { parseArgs } from "./args.ts";
import { isSubcommand } from "./completion.ts";

function fail(message: string): never {
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
}

/**
 * The directory a session starts in: the worktree `--worktree <name>` names (entered, with a line on stderr saying what
 * was done), else the current directory. Help and version requests change nothing. `--worktree` belongs to session
 * runs only; with a subcommand, ACP mode, `--export` or `--list-models`, or with a flag that opens a saved session, it
 * is refused before anything is created. Any failure prints its reason and exits with status 1.
 */
export async function startupCwd(args: string[]): Promise<string> {
	const parsed = parseArgs(args);
	const { worktree, help, version } = parsed;
	// `--trust` is the user's grant: a run the agent started from a session's shell may not record one.
	if (parsed.trust === true && insideSessionShell()) fail(sessionShellRefusal("record trust for --trust"));
	// `--trust` lets a headless run (or a later isolated subagent) record the grant for a worktree it creates.
	allowWorktreeGrants(parsed.trust === true);
	if (worktree === undefined || help || version) return process.cwd();
	const notSession = isSubcommand(args)
		? `the "${args[0]}" command`
		: parsed.mode === "acp"
			? "--mode acp"
			: parsed.export
				? "--export"
				: parsed.listModels !== undefined
					? "--list-models"
					: undefined;
	if (notSession) fail(`--worktree starts an interactive or print session and cannot be used with ${notSession}.`);
	// These open a saved session, which runs in the directory it recorded: the worktree would be made and then unused.
	const opens = [
		parsed.continue && "--continue",
		parsed.resume && "--resume",
		parsed.session && "--session",
		parsed.fork && "--fork",
	].filter(Boolean);
	if (opens.length > 0) {
		fail(
			`--worktree starts a new session and cannot be combined with ${opens.join(", ")}; run that from inside the worktree instead.`,
		);
	}
	try {
		const interactive = process.stdin.isTTY && process.stdout.isTTY && !parsed.print && parsed.mode === undefined;
		const ask = interactive
			? (request: WorktreeTrustRequest) =>
					confirmWorktreeTrust(SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false }), request)
			: undefined;
		const info = await enterWorktree(worktree, process.cwd(), ask);
		process.stderr.write(`${describeWorktree({ ...info, path: path.relative(info.main, info.path) || info.path })}\n`);
		return process.cwd();
	} catch (error) {
		return fail(errorMessage(error));
	}
}
