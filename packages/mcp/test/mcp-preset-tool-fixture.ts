import type { CallToolResult, ProgressNotification, Tool } from "../src/client/index.ts";
import type { ToolDefinition } from "../../coding-agent/src/core/features/index.ts";
import { defineOctocodeTool, octocodeToolName } from "../src/presets/octocode/tools.ts";
import { OCTOCODE_SERVER } from "../src/presets/octocode/names.ts";
/** What the extension registers a server's tool as. */
interface ToolBinding {
	exposure?: "direct" | "hidden";
	/** The tools' namespace: the server's name and its instructions. */
	namespace: NonNullable<ToolDefinition["namespace"]>;
	call(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onProgress?: (progress: ProgressNotification) => void,
	): Promise<CallToolResult>;
}

/** Standalone binding for a preset tool; registration and execution use the common host factory. */
export function octocodeToolDefinition(tool: Tool, binding: ToolBinding) {
	return defineOctocodeTool({
		server: OCTOCODE_SERVER,
		tool,
		name: octocodeToolName(tool.name),
		exposure: binding.exposure ?? "direct",
		namespace: binding.namespace,
		timeoutMs: 60_000,
		getClient: async () => ({
			callTool: (name, args, options) => binding.call(name, args, options.signal, options.onProgress),
		}),
	});
}
