import type { FeatureContext, SetupPick } from "../../core/features/index.ts";
import { autoCompactAt, compactionThinking } from "../shared/tokens.ts";
import { limitsFor } from "./limits.ts";
import { contextTokens, recoveredBelowBand, toolDefinitionChars } from "./pacing.ts";

/**
 * Whether the context after a compaction sits within the recovery band of the model's trigger. A model without a window
 * or a context of unknown size counts as recovered: the check then refuses nothing.
 */
export function leftInRecoveryBand(
	api: Parameters<typeof limitsFor>[0] &
		Parameters<typeof compactionThinking>[0] &
		SetupPick<"tools", "getActive" | "getAll">,
	ctx: Pick<FeatureContext, "model" | "getContextUsage" | "getSystemPrompt" | "sessionManager">,
): boolean {
	const model = ctx.model;
	if (!model || !(model.contextWindow > 0)) return true;
	const trigger = autoCompactAt(model, compactionThinking(api), limitsFor(api, model).compaction);
	return recoveredBelowBand(contextTokens(ctx, toolDefinitionChars(api)), trigger);
}
