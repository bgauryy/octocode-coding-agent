import type { AttachToolStates } from "@octocodeai/octocode-contracts/daemon";
import { currentMcpToolStates, currentMcpServerNames, type McpServerToolStates } from "../../../../mcp/src/api.ts";
import type { NativeToolsLive, ToolExposureOptions } from "./tool-exposure.ts";

/** What a running session declares of each tool, from the session (`session.tools`) to the daemon. */
export type LiveTools = Pick<ToolExposureOptions, "native" | "mcp"> & { mcpServerNames?: () => string[] | undefined };

/** This session's tool states as its attach endpoint sends them: the native tools it registered and its MCP registry's. */
export function sessionToolStates(
	native: NativeToolsLive,
	mcp: McpServerToolStates[] | undefined = currentMcpToolStates(),
	mcpServerNames: string[] | undefined = currentMcpServerNames(),
): AttachToolStates {
	return {
		native: {
			names: [...native.names],
			deferred: Object.fromEntries(native.declared),
			...(native.saved ? { saved: Object.fromEntries(native.saved) } : {}),
		},
		...(mcpServerNames ? { mcpServerNames } : {}),
		...(mcp
			? {
					mcp: mcp.map((server) => ({
						server: server.server,
						connected: server.connected,
						saved: server.saved,
						tools: server.tools.map(({ name, state, decidedBy, audit }) => ({
							name,
							state,
							decidedBy,
							...(audit ? { audit } : {}),
						})),
					})),
				}
			: {}),
	};
}

/** A session's answer as `listToolExposure` reads it; a session with no MCP host uses no server. */
export function liveTools(states: AttachToolStates): LiveTools {
	const declared = new Map(Object.entries(states.native.deferred));
	return {
		native: () => ({
			names: states.native.names,
			declared,
			...(states.native.saved ? { saved: new Map(Object.entries(states.native.saved)) } : {}),
		}),
		mcp: () => states.mcp ?? [],
		mcpServerNames: () => states.mcpServerNames,
	};
}
