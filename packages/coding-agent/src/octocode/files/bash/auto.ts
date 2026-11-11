import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import { envInt } from "../../../../../common/src/env.ts";
import { isKnownLongCommand, LONG_COMMAND_AFTER_SECONDS, neverExits } from "./long-commands.ts";
import { effectiveTimeout } from "./results.ts";

/** When a foreground command moves to the background by itself: the threshold, and which calls it applies to. */

/** Overrides the `bashBackgroundAfterSeconds` setting; 0 turns the automatic move off. */
export const BACKGROUND_AFTER_ENV = "OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS";

/** The longest a foreground wait with its own timeout holds the turn before the command moves to the background. */
const DELIBERATE_MAX_SECONDS = 600;

/** A command starting with `sleep` is stopped at its deadline, not moved to the background. */
const SLEEP_COMMAND = /^\s*sleep(?:\s|$)/;

/** Seconds a foreground command may run before it moves: the environment, else the setting, else the default; 0 = never. */
export function backgroundAfterSeconds(setting: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
	const fromEnv = envInt(env, BACKGROUND_AFTER_ENV, -1, { min: -1 });
	if (fromEnv >= 0) return fromEnv;
	return typeof setting === "number" && Number.isFinite(setting) && setting >= 0
		? setting
		: SETTINGS_DEFAULTS.bashBackgroundAfterSeconds;
}

/**
 * How long a foreground call waits, and what happens then. A call that names a `timeout` waits that long and its
 * command is stopped then (`deliberate`): the timeout is a stop time, whatever `background` says. A call that names none
 * moves to the background at the threshold, unless it is a `sleep` (never moved) or the threshold is off or not shorter
 * than the default deadline. A known long command (test runner, `yarn run check`, build, server, stream follower) moves
 * after `LONG_COMMAND_AFTER_SECONDS` when that is sooner than the threshold. Two calls with a timeout still move, so the
 * turn is not held, and their job is stopped at the timeout all the same (`stopAfterSeconds`, counted from the command's
 * start): a command that never exits by itself (`tail -f`), since waiting for it only runs out the timeout, and a
 * timeout longer than `DELIBERATE_MAX_SECONDS`, which waits that long first (`capped`).
 */
export function foregroundPlan(
	params: { command: string; timeout?: unknown; background?: boolean },
	afterSetting: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): {
	timeout: number;
	clamped: boolean;
	movable: boolean;
	auto: boolean;
	deliberate: boolean;
	capped: boolean;
	/** The call's own timeout: a command that moves to the background is stopped this long after it started. */
	stopAfterSeconds?: number;
} {
	const { seconds, clamped } = effectiveTimeout(params.timeout);
	const movable = !SLEEP_COMMAND.test(params.command);
	const base = backgroundAfterSeconds(afterSetting, env);
	const after = base > 0 && isKnownLongCommand(params.command) ? Math.min(base, LONG_COMMAND_AFTER_SECONDS) : base;
	const explicit = typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0;
	const stop = explicit ? { stopAfterSeconds: seconds } : {};
	const waits = explicit && !neverExits(params.command);
	const capped = waits && movable && seconds > DELIBERATE_MAX_SECONDS;
	if (capped)
		return { timeout: DELIBERATE_MAX_SECONDS, clamped, movable, auto: true, deliberate: false, capped, ...stop };
	const auto = movable && !waits && after > 0 && after < seconds;
	return { timeout: auto ? after : seconds, clamped, movable, auto, deliberate: explicit && !auto, capped, ...stop };
}

/** Seconds left of a timeout of `seconds` for a command that started at `startedAt`, at least one; undefined without a timeout. */
export function timeLeft(seconds: number | undefined, startedAt: number, now = Date.now()): number | undefined {
	return seconds === undefined ? undefined : Math.max(1, Math.ceil(seconds - (now - startedAt) / 1000));
}
