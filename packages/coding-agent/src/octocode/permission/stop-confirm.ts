import type { ExtensionContext } from "../../core/extensions/index.ts";
import { interactive } from "../shared/interactive.ts";
import { withDialog } from "../shared/locks.ts";
import { plural } from "../shared/render.ts";
import type { PermissionMode } from "./mode.ts";

/**
 * The `Permission.setConfirmStop` callback `index.ts` installs: before a user's mode change that clears the grants (and so
 * stops every delegated run), an interactive session names the running agents and asks once; declining keeps the mode.
 * With no live run, or no person to ask (print, RPC without UI, a subagent), the change applies as before.
 */
export function stopConfirmation(
	running: () => readonly string[],
	isSubagent: boolean,
): (ctx: ExtensionContext, mode: PermissionMode) => Promise<boolean> {
	return async (ctx, mode) => {
		const names = running();
		if (names.length === 0 || !interactive(ctx, isSubagent)) return true;
		return withDialog(() =>
			ctx.ui.confirm(
				"Running agents",
				`Switching to ${mode} stops ${plural(names.length, "running agent")} (${names.join(", ")}). Continue?`,
			),
		);
	};
}
