import type { InlineExtension } from "../extensions/types.ts";
import { type BuiltinExtension, isBuiltinExtension } from "./extension-sets.ts";
import llamaExtension from "../../octocode/llama/index.ts";
import { withCoreToolReason } from "../../octocode/permission/native-tools.ts";
import { defaultMcpExtension } from "../../../../mcp/src/default.ts";

const builtInExtensions: BuiltinExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `/mcp` (such as a third-party MCP extension) takes over
	// instead of running alongside the built-in one.
	{
		name: "mcp",
		// Its `mcp` tool is a core tool: it takes the native `reason` like every native tool.
		factory: (api) => defaultMcpExtension(withCoreToolReason(api)),
		replaceable: true,
		builtin: true,
	},
];

export function resolveExtensionFactories(additional: InlineExtension[] = [], nativeFeatures = true) {
	const builtinExtensions = new Map<string, BuiltinExtension>();
	const extensionFactories: InlineExtension[] = [];
	for (const input of [...(nativeFeatures ? builtInExtensions : []), ...additional]) {
		if (isBuiltinExtension(input)) builtinExtensions.set(input.name, input);
		else extensionFactories.push(input);
	}
	return { builtinExtensions, extensionFactories };
}
