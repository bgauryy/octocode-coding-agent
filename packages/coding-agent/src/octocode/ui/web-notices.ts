import { getApplicationPortForSession } from "../../core/application/index.ts";
import { modelWaitText } from "../../core/agent-session/model-wait.ts";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { publishUserNotice } from "../shared/user-notice.ts";

const portOf = (ctx: FeatureContext) => getApplicationPortForSession(ctx.sessionManager.getSessionId());

/**
 * Notices for the web view and the user's scripts:
 * - each notice the session's UI shows (`ui_notice`) goes to the session's application port as a live activity, so the
 *   browser lists and toasts what the terminal said (the port drops an identical notice sent just before);
 * - a model request that went quiet (`model_stall`, once per request) is announced as `model_stalled` (the Notification
 *   hooks) and listed in the web view, whose status line shows the quiet only while it lasts. The terminal and RPC
 *   clients show the quiet from `model_wait` themselves.
 */
export function registerWebNotices(api: FeatureSetup): void {
	api.bus.on("ui_notice", async (event, ctx) => {
		portOf(ctx)?.publishNotice(event.message, event.level);
	});
	api.bus.on("model_stall", async (event, ctx) => {
		const model = ctx.model ? ` (${ctx.model.provider}/${ctx.model.id})` : "";
		const message = `${modelWaitText(event.idleMs)}${model}`;
		publishUserNotice(api.channels, { type: "model_stalled", title: "Octocode: model not answering", message });
		portOf(ctx)?.publishNotice(message, "warning");
	});
}
