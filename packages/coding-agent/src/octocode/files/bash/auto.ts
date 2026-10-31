import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import { envInt } from "../../../../../common/src/env.ts";
import { effectiveTimeout } from "./results.ts";

/** When a foreground command moves to the background by itself: the threshold, and which calls it applies to. */

/** Overrides the `bashBackgroundAfterSeconds` setting; 0 turns the automatic move off. */
export const BACKGROUND_AFTER_ENV = "OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS";

/** A command starting with `sleep` is stopped at its deadline, not moved to the background (as Claude Code does). */
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
 * How long a foreground call waits. The threshold applies, and the command moves to the background, unless the call
 * deliberately waits (`background: false` together with a `timeout`), a `sleep` (which is stopped instead), or the
 * threshold is off or not shorter than the call's own deadline. A deliberate wait is also stopped at its deadline
 * (`deliberate`) instead of moving: `background: false` means the call wants its answer within that timeout.
 */
export function foregroundPlan(
	params: { command: string; timeout?: unknown; background?: boolean },
	afterSetting: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): { timeout: number; clamped: boolean; movable: boolean; auto: boolean; deliberate: boolean } {
	const { seconds, clamped } = effectiveTimeout(params.timeout);
	const movable = !SLEEP_COMMAND.test(params.command);
	const after = backgroundAfterSeconds(afterSetting, env);
	const deliberate = params.background === false && typeof params.timeout === "number" && params.timeout > 0;
	const auto = movable && !deliberate && after > 0 && after < seconds;
	return { timeout: auto ? after : seconds, clamped, movable, auto, deliberate };
}
