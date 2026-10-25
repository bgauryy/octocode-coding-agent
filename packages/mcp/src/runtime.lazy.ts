/** Loads the MCP client, transports and connection factory on first use (see connection-factory.ts). */
export const loadMcpRuntime = () => import("./connection-factory.ts");
