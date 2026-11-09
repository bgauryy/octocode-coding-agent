import { resolve } from "node:path";
import type { McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";

const relativePath = /^\.\.?(\/|$)/;

/**
 * What a server launches or connects to: the command and arguments of a local server, or the URL of a remote one.
 * Relative paths resolve against `cwd`, so two spellings of the same program match.
 */
export function mcpLaunchIdentity(config: McpServerConfig, cwd: string): string {
	if ("url" in config) return JSON.stringify(["url", config.url]);
	const part = (value: string) => (relativePath.test(value) ? resolve(cwd, value) : value);
	return JSON.stringify(["command", part(config.command), (config.args ?? []).map(part)]);
}
