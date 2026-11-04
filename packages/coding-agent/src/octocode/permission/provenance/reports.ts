import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "../../../core/features/index.ts";
import { AGENT_RESULT_TYPE } from "../../shared/messages.ts";
import type { Permission } from "../ask.ts";
import type { createProvenance } from "../provenance.ts";
import { pruneSnapshots } from "../snapshot.ts";

/**
 * Session start for the permission state: a later start (new, resume, fork, reload) keeps a narrower mode the user
 * chose, so `full` never comes back silently, and the provenance index begins empty.
 */
export function startPermissionState(
	permission: Permission,
	provenance: ReturnType<typeof createProvenance>,
	ctx: ExtensionContext,
	reason: Parameters<Permission["start"]>[1],
): void {
	permission.start(ctx, reason);
	provenance.clear();
	// Restore points older than a week go; off the start path, and never an error for the session.
	void pruneSnapshots(ctx.cwd);
}

/**
 * A background child's report arrives as a message rather than a tool result, but it is the same text from the same place:
 * it is indexed as the `agent` tool's result is (`Provenance.origin`).
 */
export function recordChildReports(
	api: Pick<ExtensionAPI, "on">,
	provenance: ReturnType<typeof createProvenance>,
): void {
	api.on("message_end", async (event, ctx) => {
		const { message } = event;
		if (message.role !== "custom" || message.customType !== AGENT_RESULT_TYPE) return;
		const { content, details } = message;
		provenance.record(
			{
				type: "tool_result",
				toolCallId: "",
				toolName: "agent",
				input: {},
				content,
				isError: false,
				details,
			} as ToolResultEvent,
			ctx,
		);
	});
}
