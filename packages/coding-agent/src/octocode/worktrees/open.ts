import { APP_NAME, getCliInvocation } from "../../config.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { say } from "../shared/commands.ts";
import { type Opener, type OpeningScope, recordTmuxOpening } from "./openings.ts";
import {
	forwardedLaunchEnv,
	launchInTmux,
	type TmuxLaunchDependencies,
	type TmuxLaunchRequest,
	type TmuxLaunchResult,
} from "../terminal-launch/tmux.ts";

/** What starting Octocode in tmux reads; the process's own by default. */
export interface OpenDependencies {
	/** Environment the tmux check and launch read. */
	env?: NodeJS.ProcessEnv;
	/** Replaces how tmux is spawned (tests). */
	tmux?: Pick<TmuxLaunchDependencies, "runner">;
	/** The program and arguments that start Octocode. */
	invocation?: () => { command: string; prefix: string[] };
	/** Who is opening: recorded with the new window or pane, so a listing says whose it is. */
	opener?: () => Opener;
	/** The database that keeps openers (tests; the default is the shared agent database). */
	openings?: OpeningScope["db"];
}

/** Where `/worktree open` puts Octocode: a new tmux window, or a pane split `right` or `down`. */
export type OpenPlacement = Pick<TmuxLaunchRequest, "placement" | "direction">;

/**
 * Starts `octocode --worktree <name>` in `folder` in a new tmux window or pane. Outside tmux, or when tmux fails, it says
 * the command to run instead; it never throws.
 */
export async function openInTmux(
	name: string,
	folder: string,
	placement: OpenPlacement,
	ctx: CommandContext,
	deps: OpenDependencies & { inTmux: boolean },
): Promise<void> {
	const env = deps.env ?? process.env;
	const { command, prefix } = (deps.invocation ?? getCliInvocation)();
	const run = `${APP_NAME} --worktree ${name}`;
	if (!deps.inTmux) {
		say(ctx, `Not inside tmux. To work there, run in any checkout of this repository:\n  ${run}`);
		return;
	}
	let opened: TmuxLaunchResult;
	try {
		opened = await launchInTmux(
			{ ...placement, command: [command, ...prefix, "--worktree", name], cwd: folder, env: forwardedLaunchEnv(env) },
			{ env, ...(deps.tmux?.runner ? { runner: deps.tmux.runner } : {}) },
		);
	} catch (error) {
		say(ctx, `Could not open a tmux ${placement.placement} (${errorMessage(error)}). Run: ${run}`, "warning");
		return;
	}
	if (deps.opener) recordTmuxOpening(opened.id, deps.opener(), { env, db: deps.openings });
	say(ctx, `Opened Octocode in tmux ${opened.placement} ${opened.id} (${run})`);
}

/** `window`, `pane`, `pane right` or `pane down` → the placement; undefined when the words are anything else. */
export function parsePlacement(words: readonly string[]): OpenPlacement | undefined {
	const [kind = "window", side, ...extra] = words;
	if (extra.length > 0) return undefined;
	if (kind === "window" && side === undefined) return { placement: "window" };
	if (kind !== "pane" || (side !== undefined && side !== "right" && side !== "down")) return undefined;
	return { placement: "pane", direction: side ?? "right" };
}
