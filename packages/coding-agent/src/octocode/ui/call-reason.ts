import { returnedPurpose } from "@octocodeai/octocode-contracts";
import { isMcpToolName } from "../../../../common/src/mcp-names.ts";
import { takesCallReason } from "../permission/native-tools.ts";
import { callReason, isInformativeReason } from "../shared/reason.ts";

/**
 * The text a tool call's one-line reason states. Native tools and the `mcp` tool require a `reason`, read from the
 * call's arguments. An MCP tool's input belongs to its server, so its line shows only the goal or reason the server's
 * returned data states (`returnedPurpose` of the result's `structuredContent`), never one from the arguments. Extension
 * tools define their own arguments, so a `reason` there may mean something else: none. None either when there is no
 * reason or one too short to say more than the title (`Edit`).
 *
 * The host puts it on every tool display, so all surfaces show the same line.
 */
export function callReasonText(toolName: string, args: unknown, structuredContent?: unknown): string | undefined {
	const reason = takesCallReason(toolName)
		? callReason(args)
		: isMcpToolName(toolName)
			? returnedPurpose(structuredContent)
			: undefined;
	return isInformativeReason(reason) ? reason.replace(/\s+/g, " ").trim() : undefined;
}
