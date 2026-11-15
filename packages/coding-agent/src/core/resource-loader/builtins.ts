import "../../octocode/mcp-host/core-install.ts";
import "../../octocode/mcp-host/render-install.ts";
import "../../octocode/ui/export-rows-install.ts";
import octocode from "../../octocode/index.ts";
import llamaFeature from "../../octocode/llama/index.ts";
import { nativeToolsPort, withCoreToolReason } from "../../octocode/permission/native-tools.ts";
import { defaultMcpExtension } from "../../../../mcp/src/api.ts";
import type { BuiltinFeatureId } from "../features/builtin-ids.ts";
import type { Feature } from "../features/types.ts";

/** The native Octocode feature set: tools, commands, hooks, permissions, subagents and the rest of `octocode/`. */
export const NATIVE_FEATURE: Feature = { id: "octocode", owner: "native", hidden: true, register: octocode };

/**
 * The built-in features. `octocode config` lists them as `builtin:<id>` entries of the `extensions` setting, where
 * `-builtin:<id>` turns one off.
 */
export const BUILTIN_FEATURES: ReadonlyArray<Feature & { id: BuiltinFeatureId }> = [
	{ id: "llama.cpp", owner: "builtin", hidden: true, register: llamaFeature },
	// Its `mcp` tool is a core tool: it takes the native `reason` like every native tool.
	{
		id: "mcp",
		owner: "builtin",
		hidden: true,
		register: (api) => defaultMcpExtension(withCoreToolReason(api), { nativeTools: nativeToolsPort() }),
	},
];
