import { setMcpReadOnlyTools } from "./mcp-reads.ts";

/**
 * The permission layer's ports, which the composition root (`index.ts`) installs because `permission` may not import
 * their owners: `mcpReadOnly` gives the MCP tools trusted server entries declare read-only (the MCP registry's roles).
 * It fails safe until installed: no MCP tool is a read.
 */
export function installPermissionPorts(ports: { mcpReadOnly: () => ReadonlySet<string> }): void {
	setMcpReadOnlyTools(ports.mcpReadOnly);
}
