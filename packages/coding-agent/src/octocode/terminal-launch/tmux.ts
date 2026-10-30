/**
 * Runs a command in a new tmux pane or window. The command goes to tmux as separate arguments (never as shell text),
 * and the new pane's id comes back from `-P -F`, so callers learn where it started.
 */

import { execFile } from "node:child_process";
import { hasTmuxSession } from "@octocodeai/octocode-tui";

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

const runTmux: TmuxRunner = (args, { cwd, env, signal }) =>
	new Promise((resolve, reject) => {
		execFile(
			"tmux",
			[...args],
			{ cwd, env, signal, timeout: TMUX_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (!error) return resolve(stdout);
				if (signal?.aborted) return reject(signal.reason ?? error);
				const detail = stderr.trim() || error.message;
				reject(new Error(`tmux failed: ${detail}`));
			},
		);
	});

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

/** Starts `request.command` in a new tmux pane or window and returns its id (`%N` for a pane, `@N` for a window). */
export async function launchInTmux(
	request: TmuxLaunchRequest,
	dependencies: TmuxLaunchDependencies = {},
): Promise<TmuxLaunchResult> {
	const env = dependencies.env ?? process.env;
	if (!hasTmuxSession(env)) throw new Error("Not running inside tmux (TMUX is not set).");
	const target = request.placement === "pane" ? env.TMUX_PANE : undefined;
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
