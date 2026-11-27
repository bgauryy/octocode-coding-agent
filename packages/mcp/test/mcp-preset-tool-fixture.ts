import type { CallToolResult, ProgressNotification, Tool } from "../src/client/index.ts";
import type { ToolDefinition } from "../../coding-agent/src/core/features/index.ts";
import { createMcpToolName } from "../src/tool-names.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const SERVER = "octocode";
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

/** Standalone binding for a server tool; registration and execution use the common host factory. */
export function octocodeToolDefinition(tool: Tool, binding: ToolBinding) {
	return createMcpToolDefinition({
		server: SERVER,
		tool,
		name: createMcpToolName(SERVER, tool.name),
		exposure: binding.exposure ?? "direct",
		namespace: binding.namespace,
		timeoutMs: 60_000,
		getClient: async () => ({
			callTool: (name, args, options) => binding.call(name, args, options.signal, options.onProgress),
		}),
	});
}
