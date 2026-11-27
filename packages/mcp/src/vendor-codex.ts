/**
 * Codex's `config.toml` (`$CODEX_HOME`, default `~/.codex`, and the project's `.codex/config.toml`): each
 * `[mcp_servers.<name>]` table becomes an `mcpServers` entry. Codex's own `[projects."<path>"]` trust entries are not
 * read: project files follow Octocode's folder trust like every other project file.
 */

import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { hostVendors } from "./host.ts";
import type { McpConfigFile } from "./paths.ts";
import {
	defined,
	literalBang,
	mapStrings,
	type McpFileRead,
	normalizeServers,
	readConfigText,
} from "./vendor-shared.ts";

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** `env_vars`: names (or `{ name }` tables) passed through from Octocode's environment. */
function passedEnv(value: unknown): Record<string, string> {
	if (!Array.isArray(value)) return {};
	const names = value.map((item) => (isRecord(item) ? item.name : item)).filter((name) => typeof name === "string");
	return Object.fromEntries(names.map((name) => [name, `\${${name}}`]));
}

/** `enabled_tools` keeps only those tools; `disabled_tools` then hides its tools. */
function toolSelection(value: Record<string, unknown>): Record<string, unknown> {
	const enabled = strings(value.enabled_tools);
	const disabled = strings(value.disabled_tools);
	if (!enabled && !disabled) return {};
	const toolExposure: Record<string, string> = {};
	for (const tool of enabled ?? []) toolExposure[tool] = "direct";
	for (const tool of disabled ?? []) toolExposure[tool] = "hidden";
	return { ...(enabled ? { exposure: "hidden" } : {}), toolExposure };
}

function codexEntry(value: unknown): Record<string, unknown> | string {
	if (!isRecord(value)) return "expected a table";
	const common = defined({
		enabled: value.enabled,
		timeout: value.tool_timeout_sec,
		...toolSelection(value),
	});
	if (value.url !== undefined) {
		const headers: Record<string, unknown> = {
			...(mapStrings(value.http_headers, literalBang) as Record<string, unknown> | undefined),
		};
		if (isRecord(value.env_http_headers))
			for (const [header, name] of Object.entries(value.env_http_headers)) headers[header] = `\${${String(name)}}`;
		if (typeof value.bearer_token_env_var === "string")
			headers.Authorization = `Bearer \${${value.bearer_token_env_var}}`;
		return defined({ ...common, url: value.url, headers: Object.keys(headers).length ? headers : undefined });
	}
	if (typeof value.command !== "string") return 'needs "command" or "url"';
	const env = { ...passedEnv(value.env_vars), ...(mapStrings(value.env, literalBang) as Record<string, unknown>) };
	return defined({
		...common,
		command: value.command,
		args: value.args,
		cwd: value.cwd,
		env: Object.keys(env).length ? env : undefined,
	});
}

export function readCodexServers(file: McpConfigFile): McpFileRead {
	const text = readConfigText(file.path);
	if (text === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = hostVendors().parseToml(text);
	} catch (error) {
		return { error: `${file.path}: ${errorMessage(error)}` };
	}
	if (!isRecord(parsed) || parsed.mcp_servers === undefined) return undefined;
	if (!isRecord(parsed.mcp_servers)) return { error: `${file.path}: "mcp_servers" must be a table` };
	return normalizeServers(file.path, parsed.mcp_servers, codexEntry);
}
