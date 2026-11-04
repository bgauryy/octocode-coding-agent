import { formatDuration } from "../../shared/format.ts";
import { configFileLines, tildePath } from "../../shared/home.ts";
import { clipText } from "../../shared/util.ts";
import { hookLabel, hookFiles } from "../config.ts";
import type { HookTiming } from "./types.ts";
import { HOOK_EVENTS, profileEvents, profileSupport, UPSTREAM_ONLY_EVENTS, type HookProtocol } from "../catalog.ts";
import type { HookConfig } from "../contracts.ts";
import { hookIdentity } from "../config/calls.ts";

export const hookCount = (config: HookConfig): number =>
	HOOK_EVENTS.reduce((sum, event) => sum + config[event].reduce((n, group) => n + group.hooks.length, 0), 0);

function timingText(timing: HookTiming | undefined): string {
	if (!timing) return "";
	const failed = timing.failed ? `, ${timing.failed} failed` : "";
	return ` · ${timing.runs} run${timing.runs === 1 ? "" : "s"}${failed}, avg ${formatDuration(timing.totalMs / timing.runs)}, max ${formatDuration(timing.maxMs)}`;
}

export function hooksReport(
	enabled: boolean,
	config: HookConfig,
	errors: string[],
	cwd: string,
	home?: string,
	timings = new Map<string, HookTiming>(),
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
		enabled ? "Hooks: on" : "Hooks: off in this subagent (its profile does not set hooks: true).",
		...(enabled ? [`Loaded (${loaded.length}):`, ...(loaded.length > 0 ? loaded : ["  none"])] : []),
		"",
		'Hook files ({"hooks": {...}}; /harness hooks events lists what each profile accepts, /harness switches them):',
		...configFileLines(hookFiles(cwd, true, home), hookFiles(cwd, false, home), home),
		...(errors.length > 0 ? ["", "Hook configuration diagnostics:", ...errors.map((error) => `  ${error}`)] : []),
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
