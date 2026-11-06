/** What the per-vendor MCP readers share: their result shape and the value escaping every foreign file needs. */

import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { stripBom } from "../../common/src/text.ts";

/**
 * One file's servers in the `mcpServers` shape, ready for validation, with per-entry problems; `error` when the file
 * cannot be used; undefined when it is missing or defines no servers section.
 */
export type McpFileRead = { servers: Record<string, unknown>; errors: string[] } | { error: string } | undefined;

/** The file's text without a byte order mark, or undefined when it does not exist. */
export function readConfigText(path: string): string | undefined {
	return existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
}

/**
 * An env or header value with a leading `!` kept literal: Octocode resolves `!cmd` as a command in these values, other
 * agents do not. `${NAME}` references stay, so they resolve at launch like an `mcp.json` value.
 */
export const literalBang = (value: string): string => (value.startsWith("!") ? `$${value}` : value);

/** A string record with each value passed through `map`; anything else unchanged, so validation reports it. */
export function mapStrings(value: unknown, map: (text: string) => string): unknown {
	if (!isRecord(value)) return value;
	const entries = Object.entries(value);
	if (!entries.every(([, text]) => typeof text === "string")) return value;
	return Object.fromEntries(entries.map(([key, text]) => [key, map(text as string)]));
}

/** `record` without its undefined values, so a missing key stays missing. */
export function defined(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/** Normalizes each entry of a servers record; `undefined` skips an entry the vendor itself ignores. */
export function normalizeServers(
	label: string,
	servers: Record<string, unknown>,
	normalize: (value: unknown) => Record<string, unknown> | string | undefined,
): { servers: Record<string, unknown>; errors: string[] } {
	const result: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [name, value] of Object.entries(servers)) {
		const entry = normalize(value);
		if (typeof entry === "string") errors.push(`${label}: server "${name}": ${entry}`);
		else if (entry) result[name] = entry;
	}
	return { servers: result, errors };
}
