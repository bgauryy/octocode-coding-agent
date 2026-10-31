import type { TSchema } from "typebox";
import { MCP_MANAGE_TOOL_NAME } from "../../../../mcp/src/servers.ts";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/index.ts";
import { withoutReason, withReason } from "../shared/reason.ts";

/**
 * Every native registration declares its permission owner here. Adding a tool requires an explicit review of its
 * effects; a read-only hint alone cannot bypass that review. Extensions outside Octocode retain their own contract.
 */
const NATIVE_PERMISSION_OWNERS = new Map([
	["graphBuild", "gate/classify: derived workspace snapshots; Rust enforces path scope"],
	["graphQuery", "Rust CLI: workspace-scoped immutable graph reads"],
	["bash", "gate/classify: shell and destructive commands"],
	["debug", "gate/classify: debugger execution; termination only stops an existing session"],
	["ollama", "gate/classify: a task runs the FreeLlama CLI on a local model; models and route read its state"],
	["browser", "gate/classify plus BrowserTool: page actions, host access, uploads and control"],
	["web", "gate/classify plus Web tool: search, resolved URLs and private hosts"],
	["file", "File tool: checked mutation transaction and source-policy projection"],
	["memory", "Memory tool: persistent memory scope checks"],
	["agent", "Agent modes: task/profile and external-process checks; session coordination and messages"],
	["askUser", "Session UI only: collects the user's answers"],
	["backlog", "Session workspace state only: backlog records and comments"],
	["archive", "Archive tool: authorized session history, checked by the history reader"],
	["compact", "Compaction policy: queues the session's own compaction for the end of the run; no workspace effect"],
	["skill", "Skill tool: reads the SKILL.md of a skill loaded into this session; no other path"],
]);

/** Whether `name` is a native tool: one with a reviewed permission owner above (MCP and extension tools are not). */
export const isNativeTool = (name: string): boolean => NATIVE_PERMISSION_OWNERS.has(name);

export const getNativeToolNames = (): string[] => [...NATIVE_PERMISSION_OWNERS.keys()];

/** Core tools registered outside the native extension that still take the native `reason`: the built-in MCP extension's `mcp`. */
const CORE_REASON_TOOLS = new Set([MCP_MANAGE_TOOL_NAME]);

/** Whether calls to `name` carry the required native `reason`: every native tool and the core tools above. */
export const takesCallReason = (name: string): boolean => isNativeTool(name) || CORE_REASON_TOOLS.has(name);

/**
 * A native tool as the model sees it: `reason` is a required argument (unless the tool declares its own). The tool's
 * `execute` never receives the one added here, so strict argument checks such as the `agent` envelope's still hold.
 * `renderCall` keeps the whole call, so rows can show it.
 */
function withReasonArgument<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
	const parameters = withReason(tool.parameters);
	if (parameters === tool.parameters) return tool;
	return {
		...tool,
		parameters,
		execute: (id, params, ...rest) => tool.execute(id, withoutReason(params), ...rest),
	};
}

/** Fail before an unreviewed native tool enters the registry, including late registrations. */
export function withNativePermissionOwners(api: ExtensionAPI): ExtensionAPI {
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		if (!isNativeTool(tool.name)) {
			throw new Error(`Native tool ${tool.name} has no permission owner; register its gate or internal check first.`);
		}
		api.registerTool(withReasonArgument(tool));
	};
	return withRegisterTool(api, registerTool);
}

/** The API of a built-in extension that registers a core tool (`mcp`): that tool takes the required `reason` too. */
export function withCoreToolReason(api: ExtensionAPI): ExtensionAPI {
	return withRegisterTool(api, (tool) =>
		api.registerTool(CORE_REASON_TOOLS.has(tool.name) ? withReasonArgument(tool) : tool),
	);
}

function withRegisterTool(api: ExtensionAPI, registerTool: ExtensionAPI["registerTool"]): ExtensionAPI {
	return new Proxy(api, {
		get(target, property, receiver) {
			return property === "registerTool" ? registerTool : Reflect.get(target, property, receiver);
		},
	});
}
