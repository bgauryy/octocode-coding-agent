/**
 * A deferred tool is declared in full after its first call in a session, where that cannot change what the provider
 * has cached. Declaring a tool again under its name is a redefinition, which only a transport whose tool loading mode
 * is `changes` expresses in place (a `tool_addition` block on Anthropic, an `additional_tools` item on OpenAI
 * Responses): the request's tool list and instruction blocks stay as they were sent at the session's start. Every
 * other transport would resend its whole tool list with the new definition, so there the tool stays thin and its
 * schema keeps arriving as a tool result (a refused call, or the `mcp` tool).
 *
 * The full declaration is then part of the transcript (the agent loop records the change as a system message), so a
 * compaction keeps it, and a resumed session or another branch finds it there (`declaredParameters`,
 * `declaredInFull`) and registers the tool in full again without a new change.
 */

import { type Api, getCurrentSystemMessage, type Model } from "@octocodeai/octocode-ai";
import { getToolLoadingMode } from "@octocodeai/octocode-ai/utils/tool-loading";
import type { Tool as McpTool } from "./client/index.ts";
import type { McpContext } from "./host/types.ts";
import { toParameters } from "./tools.ts";

/** Whether the model's transport replaces a declared tool in place, leaving the tool list it was first sent alone. */
export function redeclaresInPlace(model: unknown): boolean {
	if (typeof model !== "object" || model === null || typeof (model as { api?: unknown }).api !== "string") return false;
	return getToolLoadingMode(model as Model<Api>) === "changes";
}

/**
 * The parameters the session's transcript declares for each tool now, as JSON by tool name. Empty for a new session,
 * and when the transcript cannot be read: every deferred tool then starts thin.
 */
export function declaredParameters(ctx: McpContext): ReadonlyMap<string, string> {
	try {
		const messages = ctx.sessionManager?.buildSessionProjection().messages ?? [];
		const current = getCurrentSystemMessage(messages as Parameters<typeof getCurrentSystemMessage>[0]);
		return new Map((current?.toolsAdded ?? []).map((tool) => [tool.name, JSON.stringify(tool.parameters)]));
	} catch {
		return new Map();
	}
}

/** Whether the transcript declares the tool `name` with the server's own input schema, as a full declaration does. */
export function declaredInFull(declared: ReadonlyMap<string, string>, name: string, tool: McpTool): boolean {
	const before = declared.get(name);
	return before !== undefined && before === JSON.stringify(toParameters(tool.inputSchema));
}
