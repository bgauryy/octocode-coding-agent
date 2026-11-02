import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/** One `mcp.json` that is read, with the convention it comes from. */
export interface McpConfigFile {
	path: string;
	scope: "global" | "project";
	/** `pi` for Pi's own files; every other file belongs to Octocode (`octocode`, the shared `agents` and `mcp` conventions). */
	product: "octocode" | "pi";
	origin: "octocode" | "pi" | "agents" | "mcp";
}

/**
 * Every `mcp.json` that is read, lowest precedence first, with whether it is Pi's. Discovery lists these; the loader reads
 * them (`globalMcpConfigPaths`, `projectMcpConfigPaths`), so the two lists cannot differ. Project files need trust.
 */
export function mcpConfigFiles(agentDir: string, cwd: string): McpConfigFile[] {
	const pi = new Set(
		hostPaths()
			.legacyConfigDirs(agentDir)
			.map((dir) => join(dir, "mcp.json")),
	);
	const global = globalMcpConfigPaths(agentDir).map((path): McpConfigFile =>
		pi.has(path)
			? { path, scope: "global", product: "pi", origin: "pi" }
			: { path, scope: "global", product: "octocode", origin: "octocode" },
	);
	const project = projectMcpConfigPaths(cwd).map((path): McpConfigFile => {
		const folder = basename(dirname(path));
		const origin =
			folder === ".pi" ? "pi" : folder === ".agents" ? "agents" : basename(path) === ".mcp.json" ? "mcp" : "octocode";
		return { path, scope: "project", product: origin === "pi" ? "pi" : "octocode", origin };
	});
	return [...global, ...project];
}
