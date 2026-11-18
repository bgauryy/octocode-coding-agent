import type { SurfaceLimits } from "../../surface.ts";

/**
 * What Claude Code cuts or defers, for `analyzeSurface`. Source: https://code.claude.com/docs/en/mcp
 * - hostDescriptionChars 4096: the cut for a tool description loaded upfront (2,048 before v2.1.296). A tool loaded
 *   through tool search is cut at 16,384 instead; `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` overrides both.
 * - instructionsChars 4096: the cut for server instructions (2,048 before v2.1.296).
 * - deferShare 0.1: the `ENABLE_TOOL_SEARCH=auto` rule, which defers MCP tools once their definitions reach 10% of the
 *   context window (`auto:N` sets another percentage). By default tool search is on and defers every MCP tool on
 *   supported models, so a `tools-deferred` issue describes threshold mode only.
 */
export const CLAUDE_CODE_LIMITS: Partial<SurfaceLimits> = {
	hostDescriptionChars: 4096,
	instructionsChars: 4096,
	deferShare: 0.1,
};
