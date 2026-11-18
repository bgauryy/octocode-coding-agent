import type { FeatureSetup, SetupPick, FeatureContext, ToolResultEvent } from "../../../core/features/index.ts";
import { AGENT_RESULT_TYPE, JOB_TYPE } from "../../shared/messages.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { Permission } from "../ask.ts";
import type { createProvenance } from "../provenance.ts";
import { CHILD_EXPOSURE_EVENT, type ChildExposure } from "./exposure.ts";
import { pruneSnapshots } from "../snapshot.ts";

/**
 * Session start for the permission state: a later start (new, resume, fork, reload) keeps a narrower mode the user
 * chose, so `full` never comes back silently, and the provenance index begins empty.
 */
export function startPermissionState(
	permission: Permission,
	provenance: ReturnType<typeof createProvenance>,
	ctx: FeatureContext,
	reason: Parameters<Permission["start"]>[1],
): void {
	permission.start(ctx, reason);
	provenance.clear();
	// Restore points older than a week go; off the start path, and never an error for the session.
	void pruneSnapshots(ctx.cwd);
}

/**
 * What a subagent says about its own run, both ways. A parent applies what a child's relay published
 * (`CHILD_EXPOSURE_EVENT`) before that child's report is indexed, so a child that read nothing untrusted is trusted. A
 * subagent sends its own state with its last word, at session end (`Permission.shutdown`, once before the lifecycle's own call).
 *
 * A background child's report arrives as a message rather than a tool result, but it is the same text from the same place:
 * it is indexed as the `agent` tool's result is (`Provenance.origin`). So is the output of a background bash job (also a
 * command that outlived its deadline): it is indexed as the foreground `bash` result of the job's command, so a
 * backgrounded `curl` taints its text as a foreground one does. Only the tail the report carries is indexed; the log it
 * names is not, as a foreground result's log is not.
 */
export function recordChildReports(
	api: SetupPick<"bus", "on"> & Pick<FeatureSetup, "channels">,
	provenance: ReturnType<typeof createProvenance>,
	permission: Pick<Permission, "shutdown">,
	isSubagent: boolean,
): void {
	api.channels.on(CHILD_EXPOSURE_EVENT, (data) => {
		const { child, exposed } = data as ChildExposure;
		if (typeof child === "string" && typeof exposed === "boolean") provenance.childExposure(child, exposed);
	});
	if (isSubagent) api.bus.on("session_shutdown", async (_event, ctx) => permission.shutdown(ctx, provenance.exposed()));
	api.bus.on("message_end", async (event, ctx) => {
		const { message } = event;
		if (message.role !== "custom") return;
		const { content, details } = message;
		let toolName: string;
		let input: Record<string, unknown> = {};
		if (message.customType === AGENT_RESULT_TYPE) toolName = "agent";
		else if (message.customType === JOB_TYPE) {
			toolName = "bash";
			if (isRecord(details) && typeof details.command === "string") input = { command: details.command };
		} else return;
		provenance.record(
			{ type: "tool_result", toolCallId: "", toolName, input, content, isError: false, details } as ToolResultEvent,
			ctx,
		);
	});
}
