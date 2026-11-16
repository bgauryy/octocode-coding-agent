/**
 * Cursor's `mcp.json` (`~/.cursor/mcp.json` and the project's `.cursor/mcp.json`), with Cursor's interpolation:
 * `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}` and `${/}` resolve when read;
 * `${env:NAME}` becomes `${NAME}` in env and header values (resolved at launch, like an `mcp.json` value) and the
 * variable's value elsewhere. Cursor's `envFile` is not read.
 */

import { basename, sep } from "node:path";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { stripJsonComments } from "@octocodeai/octocode-common/json";
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

const VARIABLE =
	/\$\{(env:[A-Za-z_][A-Za-z0-9_]*|userHome|workspaceFolder|workspaceFolderBasename|pathSeparator|\/)\}/g;

class UnsetVariable extends Error {}

/** `text` with Cursor's variables resolved; `deferEnv` keeps `${env:NAME}` as `${NAME}` for launch-time resolution. */
function interpolate(text: string, workspace: string, deferEnv: boolean): string {
	return text.replace(VARIABLE, (_match, name: string) => {
		if (name.startsWith("env:")) {
			const variable = name.slice(4);
			if (deferEnv) return `\${${variable}}`;
			const value = process.env[variable];
			if (value === undefined) throw new UnsetVariable(`\${env:${variable}} is not set`);
			return value;
		}
		if (name === "userHome") return hostVendors().home();
		if (name === "workspaceFolder") return workspace;
		if (name === "workspaceFolderBasename") return basename(workspace);
		return sep;
	});
}

function cursorEntry(value: unknown, workspace: string): Record<string, unknown> | string {
	if (!isRecord(value)) return "expected an object";
	const now = (text: unknown) => (typeof text === "string" ? interpolate(text, workspace, false) : text);
	const atLaunch = (text: string) => literalBang(interpolate(text, workspace, true));
	try {
		const auth = isRecord(value.auth) ? value.auth : undefined;
		const oauth = auth
			? defined({
					clientId: now(auth.CLIENT_ID),
					clientSecret: typeof auth.CLIENT_SECRET === "string" ? atLaunch(auth.CLIENT_SECRET) : auth.CLIENT_SECRET,
					scope: Array.isArray(auth.scopes) ? auth.scopes.join(" ") : undefined,
				})
			: undefined;
		if (value.url !== undefined)
			return defined({ url: now(value.url), headers: mapStrings(value.headers, atLaunch), oauth });
		if (value.type !== undefined && value.type !== "stdio")
			return `transport type ${JSON.stringify(value.type)} is not supported`;
		if (typeof value.command !== "string") return 'needs "command" or "url"';
		return defined({
			command: now(value.command),
			args: Array.isArray(value.args) ? value.args.map(now) : value.args,
			env: mapStrings(value.env, atLaunch),
		});
	} catch (error) {
		if (error instanceof UnsetVariable) return error.message;
		throw error;
	}
}

/** `workspace` is the folder `${workspaceFolder}` names: the session folder. */
export function readCursorServers(file: McpConfigFile, workspace: string): McpFileRead {
	const text = readConfigText(file.path);
	if (text === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(text));
	} catch (error) {
		return { error: `${file.path}: ${errorMessage(error)}` };
	}
	if (!isRecord(parsed) || parsed.mcpServers === undefined) return undefined;
	if (!isRecord(parsed.mcpServers)) return { error: `${file.path}: "mcpServers" must be an object` };
	return normalizeServers(file.path, parsed.mcpServers, (value) => cursorEntry(value, workspace));
}
