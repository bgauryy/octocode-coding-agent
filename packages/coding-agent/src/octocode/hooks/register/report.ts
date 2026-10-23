import { HOOKS_ENV } from "../../shared/env.ts";
import { formatDuration } from "../../shared/format.ts";
import { configFileLines, tildePath } from "../../shared/home.ts";
import { clipText } from "../../shared/util.ts";
import { HOOK_EVENTS, hookLabel, type HookConfig, hookFiles, hookIdentity } from "../config.ts";
import type { HookTiming } from "./types.ts";

export const hookCount = (config: HookConfig): number =>
	HOOK_EVENTS.reduce((sum, event) => sum + config[event].reduce((n, group) => n + group.hooks.length, 0), 0);

function timingText(timing: HookTiming | undefined): string {
	if (!timing) return "";
	return ` · ${timing.runs} run${timing.runs === 1 ? "" : "s"}, avg ${formatDuration(timing.totalMs / timing.runs)}, max ${formatDuration(timing.maxMs)}`;
}

export function hooksReport(
	enabled: boolean,
	config: HookConfig,
	errors: string[],
	cwd: string,
	home?: string,
	timings = new Map<string, HookTiming>(),
	sourceProfiles = false,
): string {
	const loaded = HOOK_EVENTS.flatMap((event) =>
		config[event].flatMap((group) =>
			group.hooks.map((hook) => {
				const command = clipText(hookLabel(hook), 80);
				return `  ${event} [${group.matcher || "*"}] ${command}${hook.failClosed ? " [failClosed]" : ""} (${tildePath(hook.source, home)})${timingText(timings.get(`${event}\0${hookIdentity(hook)}`))}${hook.origins?.length ? ` [source ${hook.origins[0].dialect}; runtime ${hook.protocol ?? "octocode"}]` : ""}`;
			}),
		),
	);
	return [
		enabled ? `Hooks: on (${HOOKS_ENV}=1)` : `Hooks: off. Start Octocode with ${HOOKS_ENV}=1 to run them.`,
		...(enabled ? [`Loaded (${loaded.length}):`, ...(loaded.length > 0 ? loaded : ["  none"])] : []),
		"",
		`Hook files (supported hook subset, {"hooks": {...}}; events ${HOOK_EVENTS.join(", ")}):`,
		...configFileLines(hookFiles(cwd, true, home, sourceProfiles), hookFiles(cwd, false, home, sourceProfiles), home),
		...(errors.length > 0 ? ["", "Hook configuration diagnostics:", ...errors.map((error) => `  ${error}`)] : []),
	].join("\n");
}
