import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getLegacyConfigDirs, getOctocodeHome } from "../../coding-agent/src/config.ts";

function usesDefaultAgentDir(agentDir: string): boolean {
	return getLegacyConfigDirs(agentDir).length > 0 && resolve(agentDir) === resolve(getOctocodeHome());
}

/** The global `mcp.json` that MCP commands write. */
export function globalMcpConfigPath(agentDir: string): string {
	if (usesDefaultAgentDir(agentDir)) return join(homedir(), CONFIG_DIR_NAME, "mcp.json");
	return join(agentDir, "mcp.json");
}

/** Global MCP files, lowest precedence first; explicit homes and SDK directories do not inherit defaults. */
export function globalMcpConfigPaths(agentDir: string): string[] {
	const legacy = getLegacyConfigDirs(agentDir);
	const previousNative = usesDefaultAgentDir(agentDir) ? join(agentDir, "mcp.json") : undefined;
	const compatibilityPaths = legacy.length
		? [join(homedir(), CONFIG_DIR_NAME, "agent", "mcp.json"), ...(previousNative ? [previousNative] : [])]
		: [];
	return [
		...new Set([
			...legacy.reverse().map((dir) => join(dir, "mcp.json")),
			...compatibilityPaths,
			globalMcpConfigPath(agentDir),
		]),
	];
}
