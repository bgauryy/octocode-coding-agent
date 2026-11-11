import { envFlag, SUBAGENT_ENV, SUBAGENT_HOOKS_ENV } from "../../../../common/src/env.ts";

/**
 * How much of the user's hooks a session runs. A main session always runs `all`. A subagent runs `off` unless its
 * profile or its task chose otherwise:
 * - `off`: no user hook runs.
 * - `decisions`: the PreToolUse and PermissionRequest hooks run and only their deny or ask takes effect.
 * - `all`: every hook runs, as in the main session.
 */
export const HOOK_MODES = ["off", "decisions", "all"] as const;
export type HookMode = (typeof HOOK_MODES)[number];

/**
 * The mode a child starts with. A profile that sets `hooks: false` forbids hooks, whatever the task asks. Otherwise the
 * task's `hooks` field wins, then the mode an earlier run of the same child started with (a resume keeps it), then the
 * profile's own value, then `off`.
 */
export function childHookMode(profile: HookMode | undefined, task?: HookMode, started?: HookMode): HookMode {
	if (profile === "off") return "off";
	return task ?? started ?? profile ?? "off";
}

/**
 * The mode of this process, from its environment: a main session runs `all`; a subagent what its parent put in
 * `SUBAGENT_HOOKS_ENV` (`decisions`, `all` or a true flag such as `1`, which older parents sent for `all`), else `off`.
 */
export function sessionHookMode(env: NodeJS.ProcessEnv = process.env): HookMode {
	if (!envFlag(env, SUBAGENT_ENV)) return "all";
	const value = env[SUBAGENT_HOOKS_ENV]?.trim().toLowerCase();
	if (value === "decisions") return "decisions";
	return value === "all" || envFlag(env, SUBAGENT_HOOKS_ENV) ? "all" : "off";
}
