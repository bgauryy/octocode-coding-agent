/** The default transports: stdio for command servers and streamable HTTP for URL servers. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type AuthProvider,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
} from "@octocodeai/octocode-mcp";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../../core/resolve-config-value.ts";
import type { McpServerEntry } from "../config.ts";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		inheritEnv: config.inheritEnv,
		stderr: "pipe",
	});
}
