import type { Model } from "@octocodeai/octocode-ai";
import { supportsNativeToolLoading } from "@octocodeai/octocode-ai/utils/tool-loading";
import type { Tool } from "./client/index.ts";
import { DEFAULT_MCP_EXPOSURE, type McpExposure } from "./servers.ts";
import type { McpServerEntry } from "./config.ts";

/** Tool-count threshold for explicitly requested automatic exposure; an engineering heuristic. */
const MAX_DIRECT_TOOLS = 30;
/** Share of the input window (after the output reserve) that declared tool schemas may take before they defer. */
const CATALOG_WINDOW_SHARE = 0.1;

/** An approximate byte-based budget for opt-in automatic exposure, not measured provider tokens. */
function exceedsWindowShare(tools: readonly Tool[], model: Model<any>): boolean {
	const estimatedTokens = Buffer.byteLength(JSON.stringify(tools), "utf8") / 4;
	const inputWindow = Math.max(1, model.contextWindow - (model.maxTokens ?? 0));
	return estimatedTokens >= inputWindow * CATALOG_WINDOW_SHARE;
}

/**
 * Resolve automatic exposure from the catalog and the selected transport's native tool-loading support
 * (`supportsNativeToolLoading`); without discovery everything is direct.
 *
 * - Ordinary servers defer only on native loading, and then when the combined catalog has more than 30 tools or its
 *   estimated size reaches 10% of the input window.
 * - With a preset's optional `preferDeferred`, the tools defer on native loading, since
 *   a load keeps the cached prompt. Without native loading the first load rewrites the cached prompt once, so they defer
 *   only when their estimated size reaches 10% of the input window; otherwise they are declared directly.
 */
export function resolveMcpExposure(
	exposure: McpExposure,
	tools: readonly Tool[],
	model: Model<any> | undefined,
	discoveryAvailable: boolean,
	preferDeferred = false,
): Exclude<McpExposure, "auto"> {
	if (exposure !== "auto") return exposure;
	if (!discoveryAvailable) return "direct";
	const native = supportsNativeToolLoading(model);
	if (preferDeferred) {
		if (native) return "deferred";
		return model && model.contextWindow > 0 && exceedsWindowShare(tools, model) ? "deferred" : "direct";
	}
	if (!model || !native || model.contextWindow <= 0) return "direct";
	return tools.length > MAX_DIRECT_TOOLS || exceedsWindowShare(tools, model) ? "deferred" : "direct";
}

export function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/**
 * Exposures the server's tools can have, known from its config before it connects. A preset's per-tool defaults count
 * only while the config sets no server `exposure`, as in `getMcpToolExposure`.
 */
export function configuredExposures(
	entry: McpServerEntry,
	presetDefaults?: Readonly<Record<string, McpExposure>>,
): Set<McpExposure> {
	const exposures = new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
	if (entry.config.exposure === undefined)
		for (const exposure of Object.values(presetDefaults ?? {})) exposures.add(exposure);
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
