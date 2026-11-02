import {
	hookHostToggleId,
	hookSourceToggleId,
	hookToggleId,
	insideProject,
	isSwitchedOn,
	type Toggles,
} from "../../../core/extensibility/toggles.ts";
import { tildePath } from "../../shared/home.ts";
import { HOOK_EVENTS, type HookEvent } from "../catalog.ts";
import type { HookConfig, HookHandler } from "../contracts.ts";
import { hookIdentity } from "./calls.ts";

/** The toggle IDs that decide one handler, most specific first: the handler, its file, its host profile. */
export function hookToggleIds(event: HookEvent, matcher: string, hook: HookHandler, home?: string): string[] {
	const host = hook.protocol ?? "octocode";
	const source = tildePath(hook.source, home);
	return [
		hookToggleId(source, event, matcher, hookIdentity(hook)),
		hookSourceToggleId(host, source),
		hookHostToggleId(host),
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
	return isSwitchedOn(hookToggleIds(event, matcher, hook, home), toggles, insideProject(hook.source, cwd));
}

/** Drops switched-off handlers and reports how many, so `/hooks` explains the missing ones. */
export function applyHookToggles(
	config: HookConfig,
	toggles: Toggles | undefined,
	cwd: string,
	home: string | undefined,
	errors: string[],
): void {
	if (!toggles || Object.keys(toggles).length === 0) return;
	let off = 0;
	for (const event of HOOK_EVENTS)
		config[event] = config[event]
			.map((group) => ({
				...group,
				hooks: group.hooks.filter((hook) => hookSwitchedOn(event, group.matcher, hook, toggles, cwd, home) || !++off),
			}))
			.filter((group) => group.hooks.length > 0);
	if (off) errors.push(`${off} hook${off === 1 ? "" : "s"} switched off in /harness`);
}
