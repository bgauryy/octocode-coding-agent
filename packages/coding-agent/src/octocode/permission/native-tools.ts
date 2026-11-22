import type { TSchema } from "typebox";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import type { FeatureSetup, ToolDefinition } from "../../core/features/index.ts";
import { declaresReason, settleReason, withoutReason, withReason } from "../shared/reason.ts";
import { declareToolEffect, declaresEffect } from "./tool-effects.ts";
import {
	reconsiderNativeOnDemand,
	redeclareLoadedNatives,
	settleNativeDeferral,
	withNativeDeferral,
} from "./native-deferral.ts";

export { nativeToolsPort } from "./native-deferral.ts";

/**
 * Every native registration declares its permission owner here. Adding a tool requires an explicit review of its
 * effects; a read-only hint alone cannot bypass that review. Features outside Octocode retain their own contract.
 */
const NATIVE_PERMISSION_OWNERS = new Map([
	["bash", "gate/classify: shell and destructive commands"],
	["web", "gate/classify plus Web tool: search, resolved URLs and private hosts"],
	["file", "File tool: checked mutation transaction and source-policy projection"],
	[
		"archive",
		"Archive tool: reads this workspace's session history, compaction summaries and lifecycle records; changes nothing",
	],
	[
		"memory",
		"Memory tool: persistent memory scope checks (a global or pinned change asks; secrets and near-duplicates are refused); a subagent only reads",
	],
	["agent", "Agent modes: task/profile and external-process checks; session coordination and messages"],
	["models", "Session state only: lists model and provider state; check sends one small request per provider"],
	[
		"configuration",
		"Configuration tool: reads settings; every change asks the user in every mode, bypass included, and is refused without a dialog (audited); the main session only",
	],
	["askUser", "Session UI only: collects the user's answers"],
	[
		"render",
		"Session UI only: draws a status or table, collects the user's answers; changes nothing and never replaces a tool's permission",
	],
	["backlog", "Session workspace state only: backlog records and comments"],
	["backlogPlan", "Session workspace state only: backlog records (add, edit) and their listing"],
	["compact", "Compaction policy: queues the session's own compaction for the end of the run; no workspace effect"],
	["skill", "Skill tool: reads the SKILL.md of a skill loaded into this session; no other path"],
	[
		"notify",
		"gate/classify: an until-command (alone or as a check's trigger) is checked as a bash call when set (tool-gates), and against plan mode and a read-only role when it runs; the other until kinds only read this workspace's rows and reservations, and until.check is read-only but spends money only after its own first-use ask; otherwise this session's own timers",
	],
]);

/**
 * Whether `name` is a native tool: one with a reviewed permission owner above, or one that declared its effect on its
 * definition (`ToolDefinition.effect`) when it registered (MCP and feature tools are not).
 */
export const isNativeTool = (name: string): boolean => NATIVE_PERMISSION_OWNERS.has(name) || declaresEffect(name);

export const getNativeToolNames = (): string[] => [...NATIVE_PERMISSION_OWNERS.keys()];

/** Core tools registered outside the native feature that still take the native `reason`: the built-in MCP feature's `mcp`. */
const CORE_REASON_TOOLS = new Set([MCP_MANAGE_TOOL_NAME]);

/** Whether calls to `name` carry the required native `reason`: every native tool and the core tools above. */
export const takesCallReason = (name: string): boolean => isNativeTool(name) || CORE_REASON_TOOLS.has(name);

/**
 * A native tool as the model sees it: `reason` is its first property and stays required, so the model sees it is
 * expected. Before validation a missing or empty one is settled (`settleReason`): a nested value the model wrote is
 * lifted, else it is derived from the arguments, so the call never fails for it. A nested `reason` the tool does not
 * declare is removed from the arguments. The tool's `execute` never receives a top-level one added here, so strict
 * argument checks such as the `agent` envelope's still hold; a tool's own declared reason remains. `renderCall` keeps
 * the whole call, so rows can show it.
 */
function withReasonArgument<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
	const ownReason = declaresReason(tool.parameters);
	const parameters = withReason(tool.parameters);
	// A tool with its own top-level reason (notably `file`) keeps its schema, but its arguments still need settling below.
	if (parameters === tool.parameters && !ownReason) return tool;
	const declared = tool.validationParameters ?? tool.parameters;
	const stated = (value: unknown): boolean =>
		isRecord(value) && typeof value.reason === "string" && value.reason.trim() !== "";
	return {
		...tool,
		parameters,
		prepareArguments: (args) => {
			const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
			const settled = settleReason(prepared, tool.name, declared);
			// The tool's own per-item defaults (the `file` queries take the call's reason) must see a reason settled just now.
			if (tool.prepareArguments && !stated(prepared) && stated(settled)) {
				return settleReason(tool.prepareArguments(settled), tool.name, declared);
			}
			return settled as never;
		},
		execute: ownReason ? tool.execute : (id, params, ...rest) => tool.execute(id, withoutReason(params), ...rest),
	};
}

/**
 * Fail before an unreviewed native tool enters the registry, including late registrations. The deferrable tools'
 * declarations are settled first thing at `session_start` (`settleNativeDeferral`), before any request declares them.
 */
export function withNativePermissionOwners(api: FeatureSetup): FeatureSetup {
	api.bus.on("session_start", (_event, ctx) => settleNativeDeferral(api, ctx));
	api.bus.on("tool_execution_end", (_event, ctx) => redeclareLoadedNatives(api, ctx));
	api.bus.on("model_select", (_event, ctx) => reconsiderNativeOnDemand(api, ctx));
	const registerTool: FeatureSetup["tools"]["register"] = (tool) => {
		// Declaring an effect is the review: the permission layer reads it, so the tool needs no entry above.
		if (!isNativeTool(tool.name) && !tool.effect) {
			throw new Error(
				`Native tool ${tool.name} has no permission owner; declare its effect on the definition or register its gate or internal check first.`,
			);
		}
		api.tools.register(withNativeDeferral(api, withReasonArgument(declareToolEffect(tool))));
	};
	return withRegisterTool(api, registerTool);
}

/** The API of a built-in feature that registers a core tool (`mcp`): that tool takes the required `reason` too. */
export function withCoreToolReason(api: FeatureSetup): FeatureSetup {
	return withRegisterTool(api, (tool) =>
		api.tools.register(CORE_REASON_TOOLS.has(tool.name) ? withReasonArgument(tool) : tool),
	);
}

function withRegisterTool(api: FeatureSetup, register: FeatureSetup["tools"]["register"]): FeatureSetup {
	return { ...api, tools: { ...api.tools, register } };
}
