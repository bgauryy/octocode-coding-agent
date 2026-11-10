import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { ModelTier } from "./tier.ts";

/** The `subagents.models` setting: the model for each purpose the user set, each `provider/model[:level]`. */
export type ConfiguredModels = Partial<Record<ModelTier, string>>;

/** The setting's name for a purpose, as routes and listings cite it. */
export const settingKey = (tier: ModelTier): string => `subagents.models.${tier}`;

/**
 * The user's models for the `small` and `medium` purposes. Read from the global settings only, as `externalAgents` is:
 * a project file must not choose which provider a session's children spend on. An unreadable file means none are set.
 */
export function configuredSubagentModels(agentDir: string = getAgentDir()): ConfiguredModels {
	try {
		const models = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getSettings().subagents
			?.models;
		const pick = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
		const small = pick(models?.small);
		const medium = pick(models?.medium);
		return { ...(small ? { small } : {}), ...(medium ? { medium } : {}) };
	} catch {
		return {};
	}
}
