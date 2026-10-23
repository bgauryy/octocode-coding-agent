import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getLegacyConfigDirs } from "../config.ts";

/** The global `mcp.json` that MCP commands write. */
export function globalMcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

/** The project `mcp.json` that MCP commands write. */
export function projectMcpConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

/** Global MCP files, lowest precedence first; explicit homes and SDK directories do not inherit defaults. */
export function globalMcpConfigPaths(agentDir: string): string[] {
	const legacy = getLegacyConfigDirs(agentDir);
	return [
		...new Set([
			...legacy.reverse().map((dir) => join(dir, "mcp.json")),
			...(legacy.length
				? [join(homedir(), CONFIG_DIR_NAME, "mcp.json"), join(homedir(), CONFIG_DIR_NAME, "agent", "mcp.json")]
				: []),
			globalMcpConfigPath(agentDir),
		]),
	];
}

/** Project MCP files, lowest precedence first. All require project trust. */
export function projectMcpConfigPaths(cwd: string): string[] {
	return [
		...new Set([
			join(cwd, ".pi", "mcp.json"),
			join(cwd, ".mcp.json"),
			join(cwd, ".agents", "mcp.json"),
			projectMcpConfigPath(cwd),
		]),
	];
}
