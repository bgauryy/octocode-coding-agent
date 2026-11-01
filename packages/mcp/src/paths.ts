import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	projectMcpConfigPath as projectMcpFile,
	projectMcpConfigPaths as projectMcpFiles,
} from "../../common/src/mcp-paths.ts";
import { hostIdentity, hostPaths } from "./host.ts";

function usesDefaultAgentDir(agentDir: string): boolean {
	return hostPaths().legacyConfigDirs(agentDir).length > 0 && resolve(agentDir) === resolve(hostPaths().octocodeHome());
}

/** The global `mcp.json` that MCP commands write. */
export function globalMcpConfigPath(agentDir: string): string {
	if (usesDefaultAgentDir(agentDir)) return join(homedir(), hostIdentity().configDirName, "mcp.json");
	return join(agentDir, "mcp.json");
}

/** Global MCP files, lowest precedence first; explicit homes and SDK directories do not inherit defaults. */
export function globalMcpConfigPaths(agentDir: string): string[] {
	const legacy = hostPaths().legacyConfigDirs(agentDir);
	const previousNative = usesDefaultAgentDir(agentDir) ? join(agentDir, "mcp.json") : undefined;
	const compatibilityPaths = legacy.length
		? [join(homedir(), hostIdentity().configDirName, "agent", "mcp.json"), ...(previousNative ? [previousNative] : [])]
		: [];
	return [
		...new Set([
			...legacy.reverse().map((dir) => join(dir, "mcp.json")),
			...compatibilityPaths,
			globalMcpConfigPath(agentDir),
		]),
	];
}

/** The project `mcp.json` that MCP commands write. */
export const projectMcpConfigPath = (cwd: string): string => projectMcpFile(cwd, hostIdentity().configDirName);

/** Project MCP files, lowest precedence first. All require project trust. */
export const projectMcpConfigPaths = (cwd: string): string[] => projectMcpFiles(cwd, hostIdentity().configDirName);
