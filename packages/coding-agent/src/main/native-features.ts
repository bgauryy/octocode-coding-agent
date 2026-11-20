// The host ports the native features need, installed wherever the native set is composed.
import "../octocode/mcp-host/core-install.ts";
import "../octocode/mcp-host/render-install.ts";
import "./export-rows-install.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { defaultMcpFeature } from "../../../mcp/src/api.ts";
import type { FeatureContext, FeatureSetup } from "../core/features/index.ts";
import type { NativeFeatureSet } from "../core/resource-loader/types.ts";
import octocode from "../octocode/index.ts";
import { leanMainPolicy } from "../core/lean-main.ts";
import { nativeToolsPort, withCoreToolReason } from "../octocode/permission/native-tools.ts";

/** A main session on a model the lean policy covers (`core/lean-main.ts`): its MCP feature defers every open tool. */
const leanSession =
	(api: FeatureSetup) =>
	(model: unknown): boolean =>
		!envFlag(process.env, SUBAGENT_ENV) &&
		leanMainPolicy(model as FeatureContext["model"], typeof api.settings.get === "function" ? api.settings.get() : {});

/**
 * The native feature set each entry point passes to the resource loader. The built-ins are always registered, with no
 * switch: `--no-mcp` is the only way to start without MCP, and the `/mcp` view or `mcp.json` turn single servers off.
 * The native feature is tools, commands, hooks, permissions, subagents and the rest of `octocode/`.
 */
export const NATIVE_FEATURES: NativeFeatureSet = {
	builtins: [
		// Its `mcp` tool is a core tool: it takes the native `reason` like every native tool.
		{
			id: "mcp",
			owner: "builtin",
			hidden: true,
			register: (api) =>
				defaultMcpFeature(withCoreToolReason(api), { nativeTools: nativeToolsPort(), leanSession: leanSession(api) }),
		},
	],
	native: { id: "octocode", owner: "native", hidden: true, register: octocode },
};
