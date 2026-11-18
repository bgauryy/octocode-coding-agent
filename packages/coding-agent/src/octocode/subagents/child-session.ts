import type { FeatureSetup } from "../../core/features/index.ts";
import { registerCacheGroup } from "./cache-group.ts";
import { registerIdentityReminder } from "./identity-reminder.ts";

/** What a subagent's own session records about itself: its identity reminder and its cache group. */
export function registerChildSession(api: FeatureSetup, env: NodeJS.ProcessEnv = process.env): void {
	registerIdentityReminder(api, env);
	registerCacheGroup(api, env);
}
