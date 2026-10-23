import type { CallToolResult } from "@octocodeai/octocode-mcp";
import type { EventBus } from "../../core/event-bus.ts";

export type McpHookCaller = (request: {
	server: string;
	tool: string;
	input: Record<string, unknown>;
	signal: AbortSignal;
	waitForConnection: boolean;
}) => Promise<CallToolResult>;
const REQUEST_CALLER = "mcp:hook-caller:request";

/** A session's configured MCP owner handles trusted hook calls without recursive tool events. */
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
