import type { McpDeferRole } from "../../../../mcp/src/api.ts";

/**
 * What a subagent started without a role gets where a role's front matter would decide (`profiles.ts`). A role's own
 * field replaces each, an absent one included.
 */

/** The skills its prompt lists (a role's `catalog:`); the rest stay loadable by name. */
export const GENERAL_CATALOG: readonly string[] = [
	"octocode-research",
	"octocode-local-research",
	"octocode-github-research",
	"octocode-clasify",
	"octocode-debugging",
	"octocode-engineer",
	"octocode-test-plan",
	"octocode-clean-agentic-code",
	"octocode-documentation",
];

/**
 * The MCP tool roles it defers (a role's `mcpDefer:`). A roleless child does mixed work, so without this every such
 * child would declare its coordinator's promoted read-only and judge tools in full on every request; deferred, they stay
 * callable and load through the `mcp` tool.
 */
export const GENERAL_MCP_DEFER: readonly McpDeferRole[] = ["readOnly"];
