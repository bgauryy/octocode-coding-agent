import type { AcpPermission } from "../../../../acp/src/client/client.ts";
import { TOOL_SERVER } from "./route.ts";

type PermissionRequest = Parameters<AcpPermission>[0];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Whether one agent namespace of a tool call's `_meta` names a call to Octocode's MCP server, as Claude Code's adapter
 * sends it: `toolName` `mcp__octocode__<tool>` (the SDK's name for a tool its MCP client serves) and, from newer
 * adapters, `mcpServer.name`. Undefined when the namespace names no tool.
 */
function namesOurs(namespace: Record<string, unknown>): boolean | undefined {
	const { toolName } = namespace;
	const server = asRecord(namespace.mcpServer)?.name;
	if (toolName === undefined && server === undefined) return undefined;
	if (server !== undefined && server !== TOOL_SERVER) return false;
	return typeof toolName === "string" && toolName.startsWith(`mcp__${TOOL_SERVER}__`);
}

/**
 * Whether a permission request is for an Octocode MCP tool, by the structured identity in its `_meta`: every namespace
 * that names the tool must name ours. ACP carries no MCP server field, and the title is free text an agent writes for
 * its own tools too, so the title never decides; a request with no structured identity is not ours.
 */
function isOctocodeToolCall(request: PermissionRequest): boolean {
	const verdicts = Object.values(asRecord(request.toolCall._meta) ?? {}).flatMap((value) => {
		const namespace = asRecord(value);
		const verdict = namespace ? namesOurs(namespace) : undefined;
		return verdict === undefined ? [] : [verdict];
	});
	return verdicts.length > 0 && verdicts.every(Boolean);
}

/**
 * An external agent's own permission requests: one for an Octocode tool is allowed (Octocode's gate decides inside the
 * call), any other is refused, so the agent's own edits and commands never run on its say-so.
 */
export const octocodeToolsOnly: AcpPermission = async (request) => {
	const ours = isOctocodeToolCall(request);
	const option = request.options.find((entry) => entry.kind === (ours ? "allow_once" : "reject_once"));
	return option
		? { outcome: { outcome: "selected", optionId: option.optionId } }
		: { outcome: { outcome: "cancelled" } };
};
