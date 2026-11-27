/** Default transports: stdio for commands and Streamable HTTP for URLs. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AuthProvider, type McpTransport, StdioTransport, StreamableHttpTransport } from "../client/index.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import type { McpServerEntry } from "../config.ts";
import { hostSandbox } from "../host.ts";
import type { StdioLaunchWrapper } from "../client/transports/stdio-launch.ts";

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

/** The sandbox an opted-in server (`sandbox: true`) starts in: the host's, or a refusal when the host has none. */
function sandboxFor(name: string): StdioLaunchWrapper {
	return (launch) => {
		const sandbox = hostSandbox();
		if (!sandbox)
			return Promise.reject(
				new Error(`MCP server "${name}" sets sandbox: true, but this host has no command sandbox; it was not started.`),
			);
		return sandbox.wrapStdio(launch);
	};
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		const options = {
			url: config.url,
			headers: config.literalHeaders
				? { ...config.headers }
				: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		};
		return new StreamableHttpTransport(options);
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
		...(config.sandbox === true ? { wrapLaunch: sandboxFor(name) } : {}),
	});
}
