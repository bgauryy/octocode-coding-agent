import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { McpAddCommand } from "@octocodeai/octocode-contracts/config";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import { validateMcpServerConfig } from "./servers.ts";

/** One server as pasted: the executable or endpoint plus its secrets-bearing maps, before a scope is chosen. */
export type PastedDefinition =
	| { transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }
	| { transport: "http"; url: string; headers?: Record<string, string> };

/** `name` is undefined for a bare server object; the caller asks for it. */
export interface PastedServer {
	name: string | undefined;
	definition: PastedDefinition;
}

export type McpPasteParse = { servers: PastedServer[] } | { errors: string[] };

const MAX_ERRORS = 8;
const NAME_RULE = 'use letters, digits, "_" and "-", with no "__" and no "_" or "-" at the end';
const STDIO_KEYS = ["type", "command", "args", "env"];
const HTTP_KEYS = ["type", "url", "headers"];

/** A segment of an error path. Server names are not secrets, but an invalid one may hold anything: quote and cap it. */
function segment(key: string): string {
	return /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : JSON.stringify(key.slice(0, 40));
}
const at = (base: string, key: string): string => (base ? `${base}.${segment(key)}` : segment(key));

/** Why `name` cannot name a server, in words that do not quote it; undefined when it can. */
export function mcpServerNameError(name: string): string | undefined {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) return `name must be 1-128 characters: ${NAME_RULE}`;
	return typeof validateMcpServerConfig(name, { command: "x" }) === "string"
		? `name is not allowed: ${NAME_RULE}`
		: undefined;
}

/** JSON.parse messages quote the text around the fault, which may be a secret: report only the position. */
function jsonFault(text: string): string | undefined {
	try {
		JSON.parse(text);
		return undefined;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "";
		const place = /line (\d+) column (\d+)/.exec(message);
		if (place) return `JSON: not valid JSON (line ${place[1]}, column ${place[2]})`;
		const offset = /position (\d+)/.exec(message);
		return offset ? `JSON: not valid JSON (character ${Number(offset[1]) + 1})` : "JSON: not valid JSON";
	}
}

function stringMap(value: unknown, path: string, errors: string[]): Record<string, string> | undefined {
	if (!isRecord(value)) {
		errors.push(`${path}: must be an object mapping names to strings`);
		return undefined;
	}
	const map: Record<string, string> = {};
	let ok = true;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") map[key] = entry;
		else {
			errors.push(`${at(path, key)}: must be a string`);
			ok = false;
		}
	}
	return ok ? map : undefined;
}

function readDefinition(value: unknown, path: string, errors: string[]): PastedDefinition | undefined {
	const label = path || "server";
	if (!isRecord(value)) {
		errors.push(`${label}: must be an object`);
		return undefined;
	}
	const { type, command, url } = value;
	if (type === "sse") {
		errors.push(`${at(path, "type")}: legacy SSE is unsupported; use a Streamable HTTP endpoint with "url"`);
		return undefined;
	}
	if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
		errors.push(`${at(path, "type")}: must be "stdio" or "http"`);
		return undefined;
	}
	if (command !== undefined && url !== undefined) {
		errors.push(`${label}: set either "command" (stdio) or "url" (http), not both`);
		return undefined;
	}
	const http = type === undefined ? url !== undefined : type !== "stdio";
	if (!http && command === undefined) {
		errors.push(`${label}: must set "command" (stdio) or "url" (http)`);
		return undefined;
	}
	const before = errors.length;
	for (const key of Object.keys(value))
		if (!(http ? HTTP_KEYS : STDIO_KEYS).includes(key))
			errors.push(`${at(path, key)}: unsupported field (supported: ${(http ? HTTP_KEYS : STDIO_KEYS).join(", ")})`);
	if (http) {
		if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
			errors.push(`${at(path, "url")}: must be an http:// or https:// URL string`);
		const headers = value.headers === undefined ? undefined : stringMap(value.headers, at(path, "headers"), errors);
		if (errors.length > before) return undefined;
		return { transport: "http", url: url as string, ...(headers ? { headers } : {}) };
	}
	if (typeof command !== "string" || !command.trim()) errors.push(`${at(path, "command")}: must be a non-blank string`);
	const args = value.args;
	if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string")))
		errors.push(`${at(path, "args")}: must be an array of strings`);
	const env = value.env === undefined ? undefined : stringMap(value.env, at(path, "env"), errors);
	if (errors.length > before) return undefined;
	return {
		transport: "stdio",
		command: command as string,
		args: (args as string[] | undefined) ?? [],
		...(env ? { env } : {}),
	};
}

/** Paths of env and header values that hold a credential literally instead of a `${VAR}` reference. */
export function literalValuePaths(servers: ReadonlyArray<{ name: string; definition: PastedDefinition }>): string[] {
	return servers.flatMap(({ name, definition }) => {
		const stdio = definition.transport === "stdio";
		const map = stdio ? definition.env : definition.headers;
		const base = at(at("mcpServers", name), stdio ? "env" : "headers");
		return Object.entries(map ?? {})
			.filter(([, value]) => value.trim() !== "" && !value.includes("${"))
			.map(([key]) => at(base, key));
	});
}

/** Strip a Markdown code fence that came along with a copied snippet. */
function unfence(text: string): string {
	const fenced = /^\s*```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
	return fenced ? (fenced[1] ?? "") : text;
}

/**
 * Accept `{"mcpServers":{name:{...}}}`, `{name:{...}}` (one or more), or one bare server object (`{command,...}` or
 * `{url,...}`, named by the caller). Errors name the JSON path and the rule, never a value.
 */
export function parseMcpPaste(input: string): McpPasteParse {
	const text = unfence(input).trim();
	const fault = jsonFault(text);
	if (fault) return { errors: [fault] };
	const root: unknown = JSON.parse(text);
	if (!isRecord(root)) return { errors: ["JSON: must be an object"] };
	const errors: string[] = [];
	const servers: PastedServer[] = [];
	const bare = ["command", "url"].some((key) => key in root && !isRecord(root[key]));
	if (bare) {
		const definition = readDefinition(root, "", errors);
		if (definition) servers.push({ name: undefined, definition });
	} else {
		const wrapped = "mcpServers" in root;
		const map = wrapped ? root.mcpServers : root;
		const base = wrapped ? "mcpServers" : "";
		if (!isRecord(map)) errors.push("mcpServers: must be an object mapping server names to definitions");
		else if (Object.keys(map).length === 0) errors.push(`${base || "JSON"}: define at least one server`);
		else {
			for (const [name, entry] of Object.entries(map)) {
				const path = at(base, name);
				const nameError = mcpServerNameError(name);
				if (nameError) errors.push(`${path}: ${nameError}`);
				const definition = readDefinition(entry, path, errors);
				if (definition && !nameError) servers.push({ name, definition });
			}
			const seen = new Map<string, string>();
			for (const { name } of servers) {
				const key = mcpNamespace(name as string);
				const first = seen.get(key);
				if (first !== undefined)
					errors.push(`${at(base, name as string)}: collides with "${first}" (same tool namespace)`);
				else seen.set(key, name as string);
			}
		}
	}
	if (errors.length > 0) {
		const shown = errors.slice(0, MAX_ERRORS);
		if (errors.length > MAX_ERRORS) shown.push(`…and ${errors.length - MAX_ERRORS} more`);
		return { errors: shown };
	}
	return { servers };
}

/** The add command for one parsed server once its name and scope are known. */
export function pastedAddCommand(
	name: string,
	scope: "global" | "workspace",
	definition: PastedDefinition,
): McpAddCommand {
	return { name, scope, ...definition };
}
