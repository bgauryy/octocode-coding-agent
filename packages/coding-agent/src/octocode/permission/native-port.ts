import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import type { McpNativeTools } from "../../../../mcp/src/api.ts";
import type { FeatureSetup, ToolDefinition } from "../../core/features/index.ts";

type Declaration = Pick<ToolDefinition, "description" | "parameters">;
/** A thin or on-demand declaration has a unique parameter object, even across sessions with identical tools. */
export const nativeLoads = new WeakMap<object, { full?: Declaration; load(): void }>();

const declaration = (tool?: Declaration) => tool && { description: tool.description, parameters: tool.parameters };

/** Capture the registry once per catalog read. Always recheck the live registry before activating a tool. */
export function nativeToolsPort(api: Pick<FeatureSetup, "tools">): McpNativeTools {
	const inspect = () => {
		const active = new Set(api.tools.getActive());
		const hidden = new Set(api.tools.getHiddenDeclarations());
		const direct = new Map<string, Declaration>();
		const deferred = new Map<string, { declaration: Declaration; load(): void }>();
		for (const tool of api.tools.getAll()) {
			const native =
				tool.sourceInfo.owner === "native" ||
				(tool.name === MCP_MANAGE_TOOL_NAME && tool.sourceInfo.owner === "builtin");
			if (!native || hidden.has(tool.name) || tool.exposure === "hidden") continue;
			const form = nativeLoads.get(tool.parameters);
			if (active.has(tool.name)) {
				if (form?.full) deferred.set(tool.name, { declaration: form.full, load: form.load });
				else direct.set(tool.name, tool);
			} else if (form && tool.onDemand) deferred.set(tool.name, { declaration: tool, load: form.load });
		}
		return {
			catalog: {
				deferred: () => [...deferred.keys()].sort(),
				schema: (name: string) => declaration(deferred.get(name)?.declaration),
				declared: (name: string) => declaration(direct.get(name)),
			},
			load: (name: string) => deferred.get(name)?.load(),
		};
	};
	const snapshot = () => inspect().catalog;
	return {
		snapshot,
		deferred: () => snapshot().deferred(),
		schema: (name) => snapshot().schema(name),
		declared: (name) => snapshot().declared(name),
		loaded: (name) => inspect().load(name),
	};
}
