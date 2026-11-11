/**
 * Which tools every agent role declares alike and which depend on the role. `orderToolNames` (`agent-session/
 * tool-definitions.ts`) declares them in that order, and the request marks where the shared part ends. A leaf module:
 * the request path reads it without importing the session.
 */

/** Tools every role is given in the same form, declared first and in this order. */
export const ROLE_INVARIANT_TOOLS = ["bash", "file", "web", "mcp"];

/**
 * Tools whose presence or declaration depends on the role (a child may lack askUser or skill), declared last and in this
 * order.
 */
export const ROLE_VARIANT_TOOLS = [
	"backlog",
	"backlogPlan",
	"archive",
	"memory",
	"askUser",
	"agent",
	"skill",
	"models",
	"compact",
];

/**
 * The first role-variant tool of a declared tool list (`orderToolNames` order), or undefined when it has none or starts
 * with one. Every tool before it is declared alike by agents of every role that share the MCP servers, so a cache
 * breakpoint on the tool before it (`toolCacheBoundary`) lets a child of one role read the tool prefix a child of another
 * role wrote.
 */
export function findToolCacheBoundary(names: readonly string[]): string | undefined {
	const index = names.findIndex((name) => ROLE_VARIANT_TOOLS.includes(name));
	return index > 0 ? names[index] : undefined;
}
