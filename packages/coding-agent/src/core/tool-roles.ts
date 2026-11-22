/**
 * Which tools every agent role declares alike and which depend on the role. `orderToolNames` (`agent-session/
 * tool-definitions.ts`) declares them in that order, and the request marks where the shared part ends. A leaf module:
 * the request path reads it without importing the session.
 *
 * A tool is role-variant when its definition says so (`roleVariant`): the definition owns that fact, so a new
 * role-dependent tool needs no change here.
 */

/** Tools every role is given in the same form, declared first and in this order. */
export const ROLE_INVARIANT_TOOLS = ["bash", "file", "web", "mcp"];

/**
 * The order role-variant tools are declared in, so request bytes stay as they were before the flag existed. A variant
 * tool not listed here follows these, sorted by name.
 */
export const ROLE_VARIANT_ORDER = [
	"backlog",
	"backlogPlan",
	"archive",
	"memory",
	"askUser",
	"agent",
	"models",
	"compact",
];

/**
 * Role-variant tools declared after every other tool, whose description changes while the session runs (the skill
 * catalog, on `/reload`): a change invalidates the provider cache from this tool on, so nothing else follows it.
 */
export const TAIL_TOOLS = ["skill"];

/**
 * The first role-variant tool of a declared tool list (`orderToolNames` order), or undefined when it has none or starts
 * with one. Every tool before it is declared alike by agents of every role that share the MCP servers, so a cache
 * breakpoint on the tool before it (`toolCacheBoundary`) lets a child of one role read the tool prefix a child of another
 * role wrote. `isRoleVariant` answers from the tool definitions (`ToolDefinition.roleVariant`).
 */
export function findToolCacheBoundary(
	names: readonly string[],
	isRoleVariant: (name: string) => boolean,
): string | undefined {
	const index = names.findIndex(isRoleVariant);
	return index > 0 ? names[index] : undefined;
}
