import { join } from "node:path";

/** The project `mcp.json` that MCP commands write, under the project's `configDir` (for example `.octocode`). */
export function projectMcpConfigPath(cwd: string, configDir: string): string {
	return join(cwd, configDir, "mcp.json");
}

/** Project MCP files, lowest precedence first. All require project trust. */
export function projectMcpConfigPaths(cwd: string, configDir: string): string[] {
	return [
		...new Set([
			join(cwd, ".pi", "mcp.json"),
			join(cwd, ".mcp.json"),
			join(cwd, ".agents", "mcp.json"),
			projectMcpConfigPath(cwd, configDir),
		]),
	];
}
