/**
 * Runs a command in a new tmux pane or window. The command goes to tmux as separate arguments (never as shell text),
 * and the new pane's id comes back from `-P -F`, so callers learn where it started.
 */

import { hasTmuxSession, paneTarget, tmuxExec } from "@octocodeai/octocode-tui/multiplexer";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../config.ts";

export type TmuxLaunchRequest = {
	placement: "pane" | "window";
	/** Pane split direction; `right` when omitted. Ignored for a window. */
	direction?: "right" | "down";
	/** The program and its arguments. */
	command: readonly string[];
	/** Start directory of the new pane or window. */
	cwd: string;
	/** Move focus to the new pane or window; default true. */
	focus?: boolean;
	/** Variables set in the new pane on top of the tmux server's environment. */
	env?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
};

export type TmuxLaunchResult = { placement: "pane" | "window"; id: string };

/** Runs `tmux <args>` and returns its standard output. */
export type TmuxRunner = (
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<string>;

export type TmuxLaunchDependencies = {
	runner?: TmuxRunner;
	env?: NodeJS.ProcessEnv;
};

const TMUX_TIMEOUT_MS = 5000;

/** Configuration locations a new pane must share with this process; tmux starts it in the server's environment. */
const FORWARDED_ENV = [ENV_AGENT_DIR, ENV_SESSION_DIR, "OCTOCODE_HOME", "OCTOCODE_AGENT_DB"] as const;

/** The variables of `env` that point a new pane at this process's configuration and sessions. */
export function forwardedLaunchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const name of FORWARDED_ENV) {
		const value = env[name];
		if (value) forwarded[name] = value;
	}
	return forwarded;
}

const runTmux: TmuxRunner = (args, { cwd, env, signal }) =>
	tmuxExec(args, { cwd, env, ...(signal ? { signal } : {}), timeoutMs: TMUX_TIMEOUT_MS });

/** One pane of the tmux server: where it is (`work:2.0`), its process and its current directory. */
export type TmuxPane = {
	id: string;
	label: string;
	pid: number;
	command: string;
	cwd: string;
	/** The window holding it (`@3`): what `new-window` printed, so a window a session opened is found by it. */
	windowId?: string;
};

const PANE_FORMAT = [
	"#{pane_id}",
	"#{session_name}:#{window_index}.#{pane_index}",
	"#{pane_pid}",
	"#{pane_current_command}",
	"#{pane_current_path}",
	"#{window_id}",
].join("\t");

/** Every pane of the tmux server `env` reaches; none when tmux is not installed, not running or fails. */
export async function listTmuxPanes(dependencies: TmuxLaunchDependencies = {}): Promise<TmuxPane[]> {
	const run = dependencies.runner ?? runTmux;
	let out: string;
	try {
		out = await run(["list-panes", "-a", "-F", PANE_FORMAT], {
			cwd: process.cwd(),
			env: dependencies.env ?? process.env,
		});
	} catch {
		return [];
	}
	return out.split("\n").flatMap((line) => {
		const [id = "", label = "", pid = "", command = "", cwd = "", windowId = ""] = line.split("\t");
		return /^%\d+$/u.test(id) && label && cwd
			? [{ id, label, pid: Number(pid) || 0, command, cwd, ...(/^@\d+$/u.test(windowId) ? { windowId } : {}) }]
			: [];
	});
}

/** tmux reads an argument ending in `;` as a command separator; a backslash before it keeps it literal. */
function escapeTrailingSemicolon(value: string): string {
	const match = /(\\*);$/u.exec(value);
	if (!match) return value;
	const backslashes = match[1]?.length ?? 0;
	return `${value.slice(0, value.length - backslashes - 1)}${"\\".repeat(backslashes + 1)};`;
}

/** The arguments after `tmux` that start `request` in a pane of `target` (or a window of the current session). */
export function buildTmuxLaunchArgs(request: TmuxLaunchRequest, target: string | undefined): string[] {
	const pane = request.placement === "pane";
	const args: string[] = [pane ? "split-window" : "new-window"];
	if (pane) args.push(request.direction === "down" ? "-v" : "-h");
	if (request.focus === false) args.push("-d");
	// tmux format-expands the start directory (`#{...}`, `#S`, `#(cmd)`); `##` is a literal `#`.
	args.push("-c", request.cwd.replaceAll("#", "##"));
	for (const [name, value] of Object.entries(request.env ?? {})) args.push("-e", `${name}=${value}`);
	if (target) args.push("-t", target);
	args.push("-P", "-F", pane ? "#{pane_id}" : "#{window_id}", "--");

	const [executable] = request.command;
	if (executable === undefined) throw new Error("tmux launch needs a command");
	if (request.command.length === 1) {
		if (executable.includes("=")) throw new Error("tmux cannot safely run a single executable name containing '='");
		// tmux runs one argument through its default-shell; `env --` makes it a direct multi-argument launch.
		args.push("/usr/bin/env", "--", executable);
	} else {
		args.push(...request.command);
	}
	return args.map(escapeTrailingSemicolon);
}

/**
 * Where a new window opens. tmux takes the current session from `TMUX_PANE`, which it sets in every pane, so nothing is
 * passed then (`new-window -t` rejects a pane id). Without `TMUX_PANE` tmux would pick its most recently used session,
 * so the session named by the last field of `TMUX` (`socket,pid,session`) is the target instead.
 */
function windowTarget(env: NodeJS.ProcessEnv): string | undefined {
	if (paneTarget(env)) return undefined;
	const session = /,(\d+)$/u.exec(env.TMUX ?? "")?.[1];
	return session === undefined ? undefined : `$${session}:`;
}

/** Starts `request.command` in a new tmux pane or window and returns its id (`%N` for a pane, `@N` for a window). */
export async function launchInTmux(
	request: TmuxLaunchRequest,
	dependencies: TmuxLaunchDependencies = {},
): Promise<TmuxLaunchResult> {
	const env = dependencies.env ?? process.env;
	if (!hasTmuxSession(env)) throw new Error("Not running inside tmux (TMUX is not set).");
	const target = request.placement === "pane" ? paneTarget(env) : windowTarget(env);
	if (request.placement === "pane" && !target) throw new Error("tmux pane launch needs TMUX_PANE.");
	const args = buildTmuxLaunchArgs(request, target);
	const run = dependencies.runner ?? runTmux;
	const stdout = await run(args, { cwd: request.cwd, env, ...(request.signal ? { signal: request.signal } : {}) });
	const id = stdout.trim();
	const valid = request.placement === "pane" ? /^%\d+$/u.test(id) : /^@\d+$/u.test(id);
	if (!valid)
		throw new Error(`tmux returned an unexpected ${request.placement} id: ${JSON.stringify(id.slice(0, 80))}`);
	return { placement: request.placement, id };
}
