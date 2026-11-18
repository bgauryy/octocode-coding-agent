import { hookItem } from "../guard/items.ts";
import { recordGate } from "../guard/registry.ts";
import { gate, scopeFor } from "../guard/store.ts";
import type { ReviewItem } from "../guard/types.ts";
import { HOOK_EVENTS } from "./catalog.ts";
import type { HookConfig, HookHandler } from "./contracts.ts";
import { hookIdentity } from "./config/calls.ts";
import { hookToggleIds } from "./config/toggles.ts";

/**
 * The feature guard's view of hooks: one review item per handler, identified by its file, event, matcher and place
 * (not its content, so a changed handler shows as changed), and pinned to its definition and any script it names.
 */

/** The shell command of a command handler (its `type` may be left out). */
const commandOf = (hook: HookHandler): string | undefined =>
	"command" in hook && typeof hook.command === "string" ? hook.command : undefined;

const label = (hook: HookHandler): string =>
	commandOf(hook) !== undefined
		? (commandOf(hook) ?? "")
		: hook.type === "http"
			? hook.url
			: hook.type === "mcp_tool"
				? `${hook.server}/${hook.tool}`
				: "prompt";

/** Every handler of `config` as a review item, keyed by the handler object. */
export function hookReviewItems(config: HookConfig, cwd: string, home?: string): Map<HookHandler, ReviewItem> {
	const items = new Map<HookHandler, ReviewItem>();
	const positions = new Map<string, number>();
	for (const event of HOOK_EVENTS)
		for (const group of config[event])
			for (const hook of group.hooks) {
				const place = JSON.stringify([hook.source, event]);
				const position = positions.get(place) ?? 0;
				positions.set(place, position + 1);
				items.set(
					hook,
					hookItem({
						id: hookToggleIds(event, group.matcher, hook, home)[0] ?? "",
						source: hook.source,
						event,
						matcher: group.matcher,
						position,
						type: hook.type ?? "command",
						definition: JSON.parse(hookIdentity(hook)) as unknown,
						...(commandOf(hook) !== undefined ? { command: commandOf(hook) } : {}),
						label: label(hook),
						// A plugin's hooks are the user's install, wherever the plugin's files sit.
						scope: hook.plugin ? "global" : scopeFor(hook.source, cwd),
						cwd,
						...(home ? { home } : {}),
					}),
				);
			}
	return items;
}

/**
 * Drops the handlers the guard withholds from `config` and returns how many. With `enforce` off every handler stays and
 * is still rated. A store fault keeps every handler (the warning is recorded for the start-up notice).
 */
export function gateHooks(config: HookConfig, cwd: string, home: string | undefined, enforce: boolean): number {
	const items = hookReviewItems(config, cwd, home);
	const result = gate("hook", [...items.values()], { enforce });
	recordGate("hook", result, enforce);
	let withheld = 0;
	for (const event of HOOK_EVENTS)
		config[event] = config[event]
			.map((group) => ({
				...group,
				hooks: group.hooks.filter((hook) => result.allowed.has(items.get(hook)?.id ?? "") || !++withheld),
			}))
			.filter((group) => group.hooks.length > 0);
	return withheld;
}
