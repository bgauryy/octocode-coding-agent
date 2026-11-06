import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectMcpConfigPath as projectMcpFile } from "../../common/src/mcp-paths.ts";
import { hostIdentity, hostPaths, hostVendors } from "./host.ts";

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

/** How a file spells its servers: the `mcpServers` JSON shape, Claude's `~/.claude.json`, Codex TOML or Cursor JSON. */
type McpConfigFormat = "mcp-json" | "claude-json" | "codex-toml" | "cursor-json";

/** The harness a file belongs to, as `VendorId` in coding-agent's `core/discovery/vendors/types.ts` spells it. */
export type McpConfigVendor = "octocode" | "agents" | "mcp-json" | "pi" | "claude" | "codex" | "cursor";

/** Vendors whose files Octocode only reads: their servers never replace Octocode's own, and `/mcp` never writes them. */
export const FOREIGN_MCP_VENDORS: ReadonlySet<string> = new Set(["claude", "codex", "cursor"]);

/** One MCP config file that may be read, with the harness it comes from. */
export interface McpConfigFile {
	path: string;
	scope: "global" | "project";
	/** `pi` for Pi's own files; every other file is listed under Octocode (its `vendor` names the harness). */
	product: "octocode" | "pi";
	origin: "octocode" | "pi" | "agents" | "mcp" | "claude" | "codex" | "cursor";
	format: McpConfigFormat;
	vendor: McpConfigVendor;
	/** `claude-json` only: the `projects` key whose `mcpServers` this entry reads; absent for the top-level `mcpServers`. */
	claudeProject?: string;
}

const file = (
	path: string,
	scope: McpConfigFile["scope"],
	vendor: McpConfigVendor,
	format: McpConfigFormat = "mcp-json",
): McpConfigFile => ({
	path,
	scope,
	product: vendor === "pi" ? "pi" : "octocode",
	origin: vendor === "mcp-json" ? "mcp" : vendor,
	format,
	vendor,
});

/**
 * Other agents' user files, lowest precedence first: Claude's `~/.claude.json` (its top-level `mcpServers`, then the
 * `projects` entry of the repository root, then that of the session folder), Codex's `config.toml`, Cursor's `mcp.json`.
 * A `CODEX_HOME` that does not resolve leaves Codex's file out (the loader reports it).
 */
function vendorGlobalFiles(cwd: string): McpConfigFile[] {
	const vendors = hostVendors();
	const claude = vendors.claudeJsonPath();
	const folder = resolve(cwd);
	const root = resolve(vendors.repoRoot(cwd));
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return path; // A missing folder keeps its spelling.
		}
	};
	const keys = real(root) === real(folder) ? [folder] : [root, folder];
	const codex = vendors.codexHome();
	return [
		file(claude, "global", "claude", "claude-json"),
		...keys.map((key) => ({ ...file(claude, "global", "claude", "claude-json"), claudeProject: key })),
		...("dir" in codex ? [file(join(codex.dir, "config.toml"), "global", "codex", "codex-toml")] : []),
		file(join(vendors.home(), ".cursor", "mcp.json"), "global", "cursor", "cursor-json"),
	];
}

/**
 * Every MCP config file that may be read, on or off, lowest precedence first: Pi's globals, other agents' user files,
 * Octocode's globals; then the project's `.pi/mcp.json` (only with Pi compatibility), `.codex/config.toml`,
 * `.cursor/mcp.json`, `.mcp.json`, `.agents/mcp.json` and Octocode's own. Discovery lists these and the loader reads them,
 * so the two cannot differ. Project files need trust; the loader skips the files of vendors that are off.
 */
export function mcpConfigFiles(agentDir: string, cwd: string): McpConfigFile[] {
	const legacy = hostPaths().legacyConfigDirs(agentDir);
	const pi = new Set(legacy.map((dir) => join(dir, "mcp.json")));
	const globals = globalMcpConfigPaths(agentDir).map((path) => file(path, "global", pi.has(path) ? "pi" : "octocode"));
	const firstOwn = globals.findIndex((entry) => entry.vendor === "octocode");
	const project = [
		...(legacy.length > 0 ? [file(join(cwd, ".pi", "mcp.json"), "project", "pi")] : []),
		file(join(cwd, ".codex", "config.toml"), "project", "codex", "codex-toml"),
		file(join(cwd, ".cursor", "mcp.json"), "project", "cursor", "cursor-json"),
		file(join(cwd, ".mcp.json"), "project", "mcp-json"),
		file(join(cwd, ".agents", "mcp.json"), "project", "agents"),
		file(projectMcpConfigPath(cwd), "project", "octocode"),
	];
	return [...globals.slice(0, firstOwn), ...vendorGlobalFiles(cwd), ...globals.slice(firstOwn), ...project];
}
