import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { readMcpConfigFile } from "./config-read.ts";
import { isMcpOverride } from "./config-write.ts";
import { FOREIGN_MCP_VENDORS, type McpConfigFile, mcpConfigFiles } from "./paths.ts";
import { validateMcpServerConfig } from "./servers.ts";

/** One server a harness's file defines, as the loader would read it. */
export interface McpFileServer {
	name: string;
	config: McpServerConfig;
	/** The file that defines it. */
	source: string;
	scope: McpConfigFile["scope"];
}

/**
 * The valid server definitions in the files of one harness (`claude`, `codex`, `cursor`, ...), whether or not that
 * harness is switched on: the preview before switching it on reads what it would bring. Reads files only (nothing is
 * started). Control-only overrides and invalid entries are left out; a project file is read only when the folder is trusted.
 */
export function listVendorMcpServers(
	vendor: string,
	options: { agentDir: string; cwd: string; projectTrusted: boolean },
): McpFileServer[] {
	const found: McpFileServer[] = [];
	for (const file of mcpConfigFiles(options.agentDir, options.cwd)) {
		if (file.vendor !== vendor || (file.scope === "project" && !options.projectTrusted)) continue;
		const read = readMcpConfigFile(file, options.cwd);
		if (!read || "error" in read) continue;
		const foreign = FOREIGN_MCP_VENDORS.has(file.vendor);
		for (const [name, value] of Object.entries(read.servers)) {
			if (!foreign && isRecord(value) && isMcpOverride(value)) continue;
			const config = validateMcpServerConfig(name, value);
			if (typeof config !== "string") found.push({ name, config, source: file.path, scope: file.scope });
		}
	}
	return found;
}
