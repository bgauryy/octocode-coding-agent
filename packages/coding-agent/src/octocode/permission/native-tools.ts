import type { TSchema } from "typebox";
import { MCP_MANAGE_TOOL_NAME } from "../../../../mcp/src/servers.ts";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/index.ts";
import { declaresReason, liftNestedReason, withoutReason, withReason } from "../shared/reason.ts";

/**
 * Every native registration declares its permission owner here. Adding a tool requires an explicit review of its
 * effects; a read-only hint alone cannot bypass that review. Extensions outside Octocode retain their own contract.
 */
const NATIVE_PERMISSION_OWNERS = new Map([
	["bash", "gate/classify: shell and destructive commands"],
	["debug", "gate/classify: debugger execution; termination and launch help (no adapter) run nothing"],
	["ollama", "gate/classify: a task runs the FreeLlama CLI on a local model; models and route read its state"],
	["web", "gate/classify plus Web tool: search, resolved URLs and private hosts"],
	["file", "File tool: checked mutation transaction and source-policy projection"],
	["memory", "Memory tool: persistent memory scope checks"],
	["agent", "Agent modes: task/profile and external-process checks; session coordination and messages"],
	["models", "Session state only: lists model and provider state; check sends one small request per provider"],
	["askUser", "Session UI only: collects the user's answers"],
	["backlog", "Session workspace state only: backlog records and comments"],
	["steps", "Session workspace state only: steps (tasks) of repository items and of this session"],
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
 * A native tool as the model sees it: `reason` is required at the top level or copied there from a nested argument
 * before validation. The tool's `execute` never receives one added here, so strict argument checks such as the `agent`
 * envelope's still hold; a tool's own declared reason remains. `renderCall` keeps the whole call, so rows can show it.
 */
function withReasonArgument<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
	const ownReason = declaresReason(tool.parameters);
	const parameters = withReason(tool.parameters);
	// A tool with its own top-level reason can already have nested slots (notably `file`), so its schema may be
	// unchanged even though its arguments still need the nested-reason preparation below.
	if (parameters === tool.parameters && !ownReason) return tool;
	return {
		...tool,
		parameters,
		prepareArguments: (args) => {
			const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
			return liftNestedReason(prepared) as never;
		},
		execute: ownReason ? tool.execute : (id, params, ...rest) => tool.execute(id, withoutReason(params), ...rest),
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
