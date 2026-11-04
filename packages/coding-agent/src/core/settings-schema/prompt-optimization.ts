import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** The `optimizePrompts` setting; the `/optimize` command writes it. */
export const OptimizePromptsSchema = Type.Boolean({
	description:
		"Rewrite each prompt you submit in the interactive terminal with one call to a cheaper model (the one the `small` purpose resolves to, else the session model), then show the rewrite and let you send it, edit it or send your original. Slash commands, `!` lines and empty input are never rewritten. `/optimize on` and `/optimize off` change it.",
	default: SETTINGS_DEFAULTS.optimizePrompts,
});
