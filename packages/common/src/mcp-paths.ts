import { join } from "node:path";

/** The project `mcp.json` that MCP commands write, under the project's `configDir` (for example `.octocode`). */
export function projectMcpConfigPath(cwd: string, configDir: string): string {
	return join(cwd, configDir, "mcp.json");
}
