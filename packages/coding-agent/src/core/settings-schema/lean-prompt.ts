import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** The `leanPrompt` setting: when the main session gets the lean policy (`octocode/turn.ts`). */
export const LeanPromptSchema = Type.Union([Type.Literal("auto"), Type.Literal("on"), Type.Literal("off")], {
	description:
		'The main session\'s policy text. "auto" (the default) uses the lean policy for a model whose context window is at most 64k tokens (65,536) or the model subagents.models.small names, and the full policy otherwise; "on" always uses the lean policy, "off" never. The lean policy states the working, safety and reporting rules only: it leaves out delegation, the rules for running subagents and the list of skills (each stays loadable by name), so a small or local model keeps its window for the work.',
	default: SETTINGS_DEFAULTS.leanPrompt,
});
