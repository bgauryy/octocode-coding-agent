import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { readOnlyRole } from "../permission/read-only-role.ts";
import { checkedAtCurrentRevision, fileEditCount } from "./feedback/revisions.ts";

/**
 * Done means checked. A run that edited files and is about to settle with no passing verification receipt for the
 * current files (`bash` with `verify: true`, exit 0, no edit or mutating command since) continues once with a short
 * note: run the check, or say plainly that none ran. A nudge, not a gate: the model may answer that it checked another way.
 */
export const VERIFY_NUDGE_TYPE = "octocode-verify-nudge";
export const VERIFY_NUDGE =
	"Files changed in this run after the last passing check (or no check ran). Run the check that proves the change with bash verify: true, or say plainly that you did not verify it and why. If you already checked another way, name how.";

export function registerVerifyNudge(api: ExtensionAPI): void {
	let nudged = false;
	let editsAtStart = 0;
	// A run is one prompt's work: the continuation this nudge asks for does not start a new one.
	api.on("before_agent_start", async (_event, ctx) => {
		nudged = false;
		editsAtStart = fileEditCount(ctx.sessionManager.getSessionId());
	});
	api.on("agent_before_settle", async (event, ctx) => {
		// Another handler (a Stop hook) already continues the run: that turn settles again, and this one is not spent.
		if (nudged || event.outcome !== "completed" || event.entries.length > 0 || readOnlyRole()) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (fileEditCount(sessionId) === editsAtStart || checkedAtCurrentRevision(sessionId)) return undefined;
		nudged = true;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: VERIFY_NUDGE_TYPE, content: VERIFY_NUDGE, display: true },
			],
			continue: true,
		};
	});
}
