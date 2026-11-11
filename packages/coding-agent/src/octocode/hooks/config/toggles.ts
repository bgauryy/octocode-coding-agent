import {
	hookHostToggleId,
	hookSourceToggleId,
	hookToggleId,
	insideProject,
	isSwitchedOn,
	type Toggles,
} from "../../../core/extensibility/toggles.ts";
import { vendorDefaultOn } from "../../../core/discovery/vendors/switch.ts";
import { vendorToggleId } from "../../../core/discovery/vendors/types.ts";
import { homeTilde } from "../../../../../common/src/home-tilde.ts";
import { HOOK_EVENTS, type HookEvent } from "../catalog.ts";
import type { HookConfig, HookHandler } from "../contracts.ts";
import { hookIdentity } from "./calls.ts";

/** The harness whose switch decides a handler: Claude Code or Codex for their own files; a plugin the user added is not. */
const hookVendor = (hook: HookHandler): "claude" | "codex" | undefined =>
	!hook.plugin && (hook.protocol === "claude" || hook.protocol === "codex") ? hook.protocol : undefined;

/**
 * The toggle IDs that decide one handler, most specific first: the handler, its file, its host profile, then for a
 * Claude Code or Codex file its harness (`harness:<host>`).
 */
export function hookToggleIds(event: HookEvent, matcher: string, hook: HookHandler, home?: string): string[] {
	const host = hook.protocol ?? "octocode";
	const source = homeTilde(hook.source, home);
	const vendor = hookVendor(hook);
	return [
		hookToggleId(source, event, matcher, hookIdentity(hook)),
		hookSourceToggleId(host, source),
		hookHostToggleId(host),
		...(vendor ? [vendorToggleId(vendor)] : []),
	];
}

/** Whether `/harness` left this handler on; a project key only reaches handlers whose file is in the repository. */
export function hookSwitchedOn(
	event: HookEvent,
	matcher: string,
	hook: HookHandler,
	toggles: Toggles | undefined,
	cwd: string,
	home?: string,
): boolean {
	const vendor = hookVendor(hook);
	return isSwitchedOn(
		hookToggleIds(event, matcher, hook, home),
		toggles,
		insideProject(hook.source, cwd),
		vendor ? vendorDefaultOn(vendor) : true,
	);
}

/**
 * Drops switched-off handlers (by `/harness`, or a harness that is off by default) and returns how many: a user's
 * choice, which `/hooks` and the startup summary show as information, not a diagnostic.
 */
export function applyHookToggles(
	config: HookConfig,
	toggles: Toggles | undefined,
	cwd: string,
	home: string | undefined,
): number {
	// No toggles: the caller lists every handler (`/harness`); a session passes its toggles, even an empty map.
	if (!toggles) return 0;
	let off = 0;
	for (const event of HOOK_EVENTS)
		config[event] = config[event]
			.map((group) => ({
				...group,
				hooks: group.hooks.filter((hook) => hookSwitchedOn(event, group.matcher, hook, toggles, cwd, home) || !++off),
			}))
			.filter((group) => group.hooks.length > 0);
	return off;
}
