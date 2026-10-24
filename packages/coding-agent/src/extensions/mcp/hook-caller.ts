import type { CallToolResult } from "@octocodeai/octocode-mcp";
import type { EventBus } from "../../core/event-bus.ts";

/**
 * One hook-initiated MCP call. The owner resolves the registered tool (`mcp__<server>__<tool>`), refuses a hidden or
 * no longer offered tool, then awaits `authorize` before it reaches the server. `authorize` rejects to refuse the call;
 * the host decides what it enforces (Octocode runs the permission gate), so the owner never calls without asking it.
 */
interface McpHookRequest {
	server: string;
	tool: string;
	input: Record<string, unknown>;
	signal: AbortSignal;
	waitForConnection: boolean;
	authorize: (call: { toolName: string; input: Record<string, unknown> }) => Promise<void>;
}
export type McpHookCaller = (request: McpHookRequest) => Promise<CallToolResult>;
/** The caller as a hook runner sees it: the host has bound `authorize`. */
export type BoundMcpHookCaller = (request: Omit<McpHookRequest, "authorize">) => Promise<CallToolResult>;
const REQUEST_CALLER = "mcp:hook-caller:request";

/** A session's configured MCP owner handles hook calls without recursive tool events (no `tool_call`, so no PreToolUse hooks); the host's `authorize` is the gate. */
export function registerMcpHookCaller(events: EventBus, caller: McpHookCaller): () => void {
	return events.on(REQUEST_CALLER, (reply) => {
		if (typeof reply === "function") reply(caller);
	});
}
export function getMcpHookCaller(events: EventBus): McpHookCaller | undefined {
	let caller: McpHookCaller | undefined;
	events.emit(REQUEST_CALLER, (value: McpHookCaller) => {
		caller = value;
	});
	return caller;
}
