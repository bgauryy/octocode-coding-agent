import type { SetupPick } from "../../core/features/index.ts";
import { limitsModelKey, type ResolvedLimits, resolveLimits } from "../../core/limits.ts";

/** The `limits` settings in force for `model` (its `limits.models` entries applied); every absent value is a built-in. */
export function limitsFor(
	api: SetupPick<"settings", "get">,
	model?: { provider?: string; id?: string },
): ResolvedLimits {
	return resolveLimits(api.settings.get().limits, limitsModelKey(model));
}
