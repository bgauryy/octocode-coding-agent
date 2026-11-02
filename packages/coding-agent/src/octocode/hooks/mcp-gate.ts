import type { BoundMcpHookCaller, McpHookCaller } from "../../../../mcp/src/hook-caller.ts";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import type { ExtensionContext } from "../../core/features/index.ts";
import { getMcpHookCaller } from "../../../../mcp/src/hook-caller.ts";

/**
 * What an `mcp_tool` hook's call goes through before it reaches the server. A hook's call is a tool call like the
 * model's: the permission gate (mode, provenance, read-only role) decides it. It skips the rest of the `tool_call`
 * pipeline on purpose: PreToolUse hooks would run for the hook's own call (recursion), and the reservation gate
 * concerns file changes. Returns a refusal reason, or undefined when the call may run.
 */
type HookMcpGate = (
	call: { toolName: string; input: Record<string, unknown> },
	ctx: ExtensionContext,
) => Promise<string | undefined>;

const REQUEST_GATE = "octocode:hook-mcp-gate:request";

/** The tool-call pipeline's owner registers the gate that hook-initiated MCP calls pass. */
export function registerHookMcpGate(events: EventBus, gate: HookMcpGate): () => void {
	return events.on(REQUEST_GATE, (reply) => {
		if (typeof reply === "function") reply(gate);
	});
}

function getHookMcpGate(events: EventBus): HookMcpGate | undefined {
	let gate: HookMcpGate | undefined;
	events.emit(REQUEST_GATE, (value: HookMcpGate) => {
		gate = value;
	});
	return gate;
}

/**
 * The session's MCP owner with this context's gate bound; a call is refused when no gate is registered. The one
 * exemption is a `PermissionRequest` hook: it is what answers a permission ask, so gating its call would ask again
 * from inside the ask and wait on itself. Hook configuration is trust-gated like a command hook, which this
 * event already runs unasked.
 */
export function boundMcpHookCaller(
	events: EventBus,
	ctx: ExtensionContext,
	event?: string,
): BoundMcpHookCaller | undefined {
	const caller: McpHookCaller | undefined = getMcpHookCaller(events);
	if (!caller) return undefined;
	return (request) =>
		caller({
			...request,
			authorize: async (call) => {
				if (event === "PermissionRequest") return;
				const gate = getHookMcpGate(events);
				const refusal = gate ? await gate(call, ctx) : "no permission gate is registered for hook MCP calls";
				if (refusal) throw new Error(`MCP hook call to ${call.toolName} refused: ${refusal}`);
			},
		});
}
