import type { Model } from "@octocodeai/octocode-ai";
import type { Tool } from "@octocodeai/octocode-mcp";
import {
	DEFAULT_MCP_EXPOSURE,
	getMcpToolExposure,
	type McpExposure,
	type McpServerConfig,
	OCTOCODE_DIRECT_TOOLS,
	OCTOCODE_SERVER,
} from "../../core/mcp-servers.ts";
import type { McpServerEntry } from "./config.ts";

/**
 * Whether a server's automatic exposure prefers discovery: the `octocode` server without an exposure of its own declares
 * its local research tools directly, and its GitHub and package tools are needed now and then, so they wait for
 * tool_search instead of filling every request.
 */
export const prefersDeferred = (server: string, config: Pick<McpServerConfig, "exposure">): boolean =>
	server === OCTOCODE_SERVER && config.exposure === undefined;

/**
 * Resolve automatic exposure from catalog size and the selected transport's native tool-loading support. With
 * `preferDeferred`, automatic exposure defers whenever discovery is available: on a transport without native tool
 * loading, the first load of such a tool rewrites the cached prompt once instead of every request carrying it.
 */
export function resolveMcpExposure(
	exposure: McpExposure,
	tools: readonly Tool[],
	model: Model<any> | undefined,
	discoveryAvailable: boolean,
	preferDeferred = false,
): Exclude<McpExposure, "auto"> {
	if (exposure !== "auto") return exposure;
	if (preferDeferred) return discoveryAvailable ? "deferred" : "direct";
	const compat = model?.compat as Record<string, unknown> | undefined;
	const nativeLoading =
		compat?.supportsToolSearch === true ||
		(compat?.supportsMidConvoSystemMessages === true &&
			(compat?.supportsAdditionalTools === true || compat?.supportsMidConvoToolChanges === true));
	if (!model || !nativeLoading || !discoveryAvailable || model.contextWindow <= 0) return "direct";
	// A conservative byte-based estimate; defer catalogs consuming at least 10% of the input window after output reserve.
	const estimatedTokens = Buffer.byteLength(JSON.stringify(tools), "utf8") / 4;
	const inputWindow = Math.max(1, model.contextWindow - (model.maxTokens ?? 0));
	return estimatedTokens >= inputWindow * 0.1 ? "deferred" : "direct";
}

export function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/** Exposures the server's tools can have, known from its config before it connects. */
export function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	const exposures = new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
	// The `octocode` server's default split: local research tools direct, the rest through tool_search.
	if (entry.name === OCTOCODE_SERVER && entry.config.exposure === undefined) {
		for (const tool of OCTOCODE_DIRECT_TOOLS) exposures.add(getMcpToolExposure(entry.config, tool, entry.name));
	}
	return exposures;
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
export function hasDirectTools(entry: McpServerEntry): boolean {
	const exposures = configuredExposures(entry);
	return exposures.has("direct") || exposures.has("auto");
}

/** Whether some of the server's tools are reached through tool_search. */
export function hasIndirectTools(entry: McpServerEntry): boolean {
	const exposures = configuredExposures(entry);
	return exposures.has("deferred");
}
