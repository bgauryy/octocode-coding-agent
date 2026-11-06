/**
 * The MCP tools trusted server entries declare read-only (`roles`), by full name. A port: the MCP registry owns that
 * state, so the composition root installs it (`index.ts`, from `currentToolRoles`). Until then no MCP tool is a read,
 * which fails safe: a read-only role refuses them and every mode treats them as writes.
 */
let readOnlyTools: () => ReadonlySet<string> = () => new Set();

/** Installs the source of the MCP tools declared read-only. */
export function setMcpReadOnlyTools(probe: () => ReadonlySet<string>): void {
	readOnlyTools = probe;
}

/**
 * Why the MCP tool `tool` is not a read, or undefined when a trusted server entry declares it read-only. The entry's
 * role alone decides: a call's arguments belong to the server and are never read here.
 */
export const mcpCallChange = (tool: string): string | undefined =>
	readOnlyTools().has(tool) ? undefined : "its server does not declare it read-only";
