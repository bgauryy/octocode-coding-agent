import type { FeatureContext } from "../../../core/features/index.ts";
import type { PermissionMode } from "../mode.ts";
import { modeSummary } from "./text.ts";

/** The answer of the client that asked to widen the mode (ACP, web); a session with no dialog to ask in refuses. */
export async function confirmWidening(ctx: FeatureContext, mode: PermissionMode): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		`Switch permissions to ${mode}?`,
		`${modeSummary(mode)}\nThis runs more actions without asking.`,
	);
}
