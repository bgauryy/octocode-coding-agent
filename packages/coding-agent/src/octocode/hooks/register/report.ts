import { formatDuration } from "../../shared/format.ts";
import { configFileLines } from "../../shared/home.ts";
import { homeTilde } from "../../../../../common/src/home-tilde.ts";
import { clipText } from "../../shared/util.ts";
import { hookLabel, hookFiles } from "../config.ts";
import type { HookTiming } from "./types.ts";
import type { HookMode } from "../../shared/hook-mode.ts";
import { HOOK_EVENTS, profileEvents, profileSupport, UPSTREAM_ONLY_EVENTS, type HookProtocol } from "../catalog.ts";
import type { HookConfig } from "../contracts.ts";
import { hookIdentity } from "../config/calls.ts";

/** What a subagent that does not run every hook runs of the user's hooks, for `/status` and `/hooks`. */
export const CHILD_MODE_NOTE: Record<HookMode, string> = {
	off: "off in this subagent (neither its profile nor its task turned hooks on)",
	decisions:
		"PreToolUse and PermissionRequest hooks can deny or ask; their other output and every other hook are off in this subagent (hook mode decisions)",
	all: "on",
};

export const hookCount = (config: HookConfig): number =>
	HOOK_EVENTS.reduce((sum, event) => sum + config[event].reduce((n, group) => n + group.hooks.length, 0), 0);

function timingText(timing: HookTiming | undefined): string {
	if (!timing) return "";
	const failed = timing.failed ? `, ${timing.failed} failed` : "";
	return ` · ${timing.runs} run${timing.runs === 1 ? "" : "s"}${failed}, avg ${formatDuration(timing.totalMs / timing.runs)}, max ${formatDuration(timing.maxMs)}`;
}

/** `mode` is `all` in a main session. In a subagent in the `decisions` mode `config` holds its PreToolUse and PermissionRequest hooks alone; in the `off` mode nothing is loaded and nothing is listed. */
export function hooksReport(
	mode: HookMode,
	config: HookConfig,
	errors: string[],
	cwd: string,
	home?: string,
	timings = new Map<string, HookTiming>(),
	switchedOff = 0,
): string {
	const enabled = mode === "all";
	const loaded = HOOK_EVENTS.flatMap((event) =>
		config[event].flatMap((group) =>
			group.hooks.map((hook) => {
				const command = clipText(hookLabel(hook), 80);
				return `  ${event} [${group.matcher || "*"}] ${command}${hook.failClosed ? " [failClosed]" : ""} (${homeTilde(hook.source, home)})${timingText(timings.get(`${event}\0${hookIdentity(hook)}`))}${hook.origins?.length ? ` [source ${hook.origins[0].dialect}; runtime ${hook.protocol ?? "octocode"}]` : ""}`;
			}),
		),
	);
	// Children run no hook unless their profile or task turns hooks on (register.ts), so say it where the hooks are configured.
	const subagentEvents = (["SubagentStart", "SubagentStop"] as const).filter((name) =>
		config[name].some((group) => group.hooks.length > 0),
	);
	const diagnostics = [
		...errors,
		...(enabled && subagentEvents.length > 0
			? [
					`${subagentEvents.join(" and ")} hooks run only in subagents whose hook mode is all (profile hooks: true, or the task's hooks field); other subagents skip them`,
				]
			: []),
	];
	return [
		enabled ? "Hooks: on" : `Hooks: ${CHILD_MODE_NOTE[mode]}.`,
		...(mode === "off" ? [] : [`Loaded (${loaded.length}):`, ...(loaded.length > 0 ? loaded : ["  none"])]),
		...(enabled && switchedOff > 0
			? [`${switchedOff} hook${switchedOff === 1 ? "" : "s"} off: harness switched off, /harness to enable`]
			: []),
		"",
		'Hook files ({"hooks": {...}}; /harness hooks events lists what each profile accepts, /harness switches them):',
		...configFileLines(hookFiles(cwd, true, home), hookFiles(cwd, false, home), home),
		...(diagnostics.length > 0
			? ["", "Hook configuration diagnostics:", ...diagnostics.map((error) => `  ${error}`)]
			: []),
	].join("\n");
}

const PROFILE_LABELS: Record<HookProtocol, string> = { octocode: "native", claude: "claude", codex: "codex" };

/** `/harness hooks events`: the catalog as text: each event with the handler types every profile accepts there. */
export function hookEventsReport(): string {
	const width = Math.max(...HOOK_EVENTS.map((event) => event.length));
	const rows = HOOK_EVENTS.map((event) => {
		const profiles = (["octocode", "claude", "codex"] as const).flatMap((protocol) => {
			const support = profileSupport(protocol, event);
			return support ? [`${PROFILE_LABELS[protocol]} (${["command", ...support.handlers].join(", ")})`] : [];
		});
		return `  ${event.padEnd(width)}  ${profiles.join(" · ")}`;
	});
	return [
		"Hook events Octocode implements, with the handler types each profile accepts:",
		...rows,
		"",
		...(["octocode", "claude", "codex"] as const).map(
			(protocol) => `${PROFILE_LABELS[protocol]}: ${profileEvents(protocol).length} events`,
		),
		"",
		"Not implemented yet (loaded files skip them with a diagnostic):",
		`  Claude Code: ${UPSTREAM_ONLY_EVENTS.claude.join(", ")}`,
		`  Codex: ${UPSTREAM_ONLY_EVENTS.codex.join(", ")}`,
	].join("\n");
}
