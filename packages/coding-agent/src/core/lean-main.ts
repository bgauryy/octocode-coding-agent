import type { FeatureContext } from "./features/index.ts";
import { splitThinkingSuffix } from "./model-resolver/reference.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import type { Settings } from "./settings-manager.ts";

/** Under `leanPrompt: "auto"`, a context window below this many tokens gets the lean main policy. */
export const LEAN_MAIN_WINDOW = 64_000;

/**
 * Whether a main session on `model` runs the lean policy: the `leanPrompt` setting, which under `"auto"` (the default)
 * chooses it for a context window under `LEAN_MAIN_WINDOW` tokens or for the model `subagents.models.small` names. The
 * full policy and its delegation rules alone take a large share of such a window. Two owners read it: the prompt
 * (`turn.ts`) and the MCP feature's exposure (`main/native-features.ts`), which then defers every open MCP tool.
 */
export function leanMainPolicy(
	model: Pick<NonNullable<FeatureContext["model"]>, "provider" | "id" | "contextWindow"> | undefined,
	settings: Pick<Settings, "leanPrompt" | "subagents">,
): boolean {
	const choice = settings.leanPrompt ?? SETTINGS_DEFAULTS.leanPrompt;
	if (choice !== "auto") return choice === "on";
	if (!model) return false;
	if (model.contextWindow > 0 && model.contextWindow < LEAN_MAIN_WINDOW) return true;
	const small = settings.subagents?.models?.small?.trim();
	if (!small) return false;
	return (splitThinkingSuffix(small)?.base ?? small) === `${model.provider}/${model.id}`;
}
