import type { Model, ProviderPlan } from "@octocodeai/octocode-ai";

/** The provider whose models run each turn in the user's own Claude Code, signed in with its own login. */
export const CLAUDE_CODE_PROVIDER = "claude-code";
/** The API its models declare: no HTTP request of Octocode's; the turn runs over ACP in Claude Code. */
export const CLAUDE_CODE_API = "claude-code-acp";
/** The MCP server name Claude Code sees Octocode's tools under (`mcp__octocode__<tool>`). */
export const TOOL_SERVER = "octocode";
/** The ACP vendor and runner id of Claude Code (`external/runners.ts`). */
export const CLAUDE_CODE_RUNNER = "claude-code";

/**
 * What the route costs and allows: the user's own plan, through Claude Code's own CLI and login. The user accepted the
 * terms risk of this route (RFC 2026-11-10, alternative G).
 */
export const CLAUDE_CODE_PLAN: ProviderPlan = {
	billing: "plan",
	access: "direct",
	terms: "https://code.claude.com/docs/en/legal-and-compliance",
	transport: "cli",
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** One model per Claude Code model alias: the id is the alias Claude Code resolves to its current model. */
function model(id: string, name: string): Model<typeof CLAUDE_CODE_API> {
	return {
		id,
		name,
		api: CLAUDE_CODE_API,
		provider: CLAUDE_CODE_PROVIDER,
		baseUrl: "acp:claude-agent-acp",
		// Claude Code chooses its own effort: Octocode's thinking levels do not reach it.
		reasoning: false,
		input: ["text"],
		cost: ZERO,
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

export const CLAUDE_CODE_MODELS: readonly Model<typeof CLAUDE_CODE_API>[] = [
	model("opus", "Opus (Claude Code)"),
	model("sonnet", "Sonnet (Claude Code)"),
	model("haiku", "Haiku (Claude Code)"),
];
