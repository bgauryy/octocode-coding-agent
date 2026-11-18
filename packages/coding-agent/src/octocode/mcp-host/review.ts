import type { McpHostPorts } from "../../../../mcp/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { mcpItem } from "../guard/items.ts";
import { visible } from "../guard/report.ts";
import { scan } from "../guard/scan.ts";
import { enforces, recordGate } from "../guard/registry.ts";
import { gate, scopeFor } from "../guard/store.ts";
import type { ReviewItem } from "../guard/types.ts";

/**
 * The feature guard for MCP: a configured server Octocode did not ship is off until the user approved its exact launch
 * (command, arguments, variable names, URL). Plugin servers are not asked here: the plugin install reviews them.
 */
type ReviewEntries = Parameters<McpHostPorts["review"]["withheld"]>[0];

/** The review items of configured MCP entries (never a built-in `default` one), in entry order. */
export const mcpReviewItems = (entries: ReviewEntries, cwd: string): ReviewItem[] =>
	entries.map((entry) =>
		mcpItem({
			name: entry.name,
			source: entry.source,
			scope: entry.scope === "project" ? scopeFor(entry.source, cwd) : "global",
			config: entry.config as unknown as Record<string, unknown>,
		}),
	);

export const review: McpHostPorts["review"] = {
	/** The static scan `/security` shows for this entry once it is loaded: same item, same rules, nothing started. */
	rate(entry, cwd) {
		const [item] = mcpReviewItems([entry], cwd);
		const { rating, findings } = scan(item);
		return { rating, findings: findings.map((finding) => visible(finding.text)) };
	},
	withheld(entries, cwd) {
		const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
		const enforce = enforces(settings, "mcp");
		const items = mcpReviewItems(entries, cwd);
		const result = gate("mcp", items, { enforce });
		recordGate("mcp", result, enforce);
		return new Set(items.filter((item) => !result.allowed.has(item.id)).map((item) => item.label));
	},
};
