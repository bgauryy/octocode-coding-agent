/** Edits of an `mcp.json`: add, remove or change one server's settings, keeping the rest of the file. */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MCP_EXPOSURE } from "./servers.ts";
import type { McpExposure, McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { hasJsonComments, stripJsonComments } from "@octocodeai/octocode-common/json";
import { stripBom } from "@octocodeai/octocode-common/text";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { withFileLockSync } from "@octocodeai/octocode-common/file-write-lock";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
export function isMcpOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

/**
 * Settings `/mcp` changes. `enabled: true`, `defaultActive: true` and `exposure: "direct"` are the defaults and remove
 * the key.
 */
export interface McpServerConfigPatch {
	enabled?: boolean;
	defaultActive?: boolean;
	exposure?: McpExposure;
	/** The server's whole per-tool map (its pins). An empty map removes the key, except in an override, where it clears the pins of the server it overrides. */
	toolExposure?: Record<string, McpExposure>;
}

/**
 * Apply `patch` to a server's settings, in a file record or in memory, so both end up the same:
 * defaults remove their key, except in overrides, which keep them since they replace the global
 * server's.
 */
export function applyMcpServerPatch(
	server: { enabled?: unknown; defaultActive?: unknown; exposure?: unknown; toolExposure?: unknown },
	patch: McpServerConfigPatch,
	keepDefaults: boolean,
): void {
	if (patch.toolExposure !== undefined) {
		if (Object.keys(patch.toolExposure).length === 0 && !keepDefaults) delete server.toolExposure;
		else server.toolExposure = { ...patch.toolExposure };
	}
	if (patch.enabled !== undefined) {
		if (patch.enabled && !keepDefaults) delete server.enabled;
		else server.enabled = patch.enabled;
	}
	if (patch.defaultActive !== undefined) {
		if (patch.defaultActive && !keepDefaults) delete server.defaultActive;
		else server.defaultActive = patch.defaultActive;
	}
	if (patch.exposure !== undefined) {
		if (patch.exposure === DEFAULT_MCP_EXPOSURE && !keepDefaults) delete server.exposure;
		else server.exposure = patch.exposure;
	}
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `override`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation. A patch function receives the server's
 * entry as the file holds it under the lock (an added override starts empty), so a change built on the current content
 * does not overwrite a concurrent one.
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch | ((current: Record<string, unknown> | undefined) => McpServerConfigPatch),
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers?.[name];
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		applyMcpServerPatch(server, typeof patch === "function" ? patch(server) : patch, isMcpOverride(server));
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced unless `replace: false` refuses it (including equivalent tool namespaces). Returns true when replaced.
 */
export function addMcpServerConfig(
	path: string,
	name: string,
	config: McpServerConfig,
	options: { replace?: boolean } = {},
): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = Object.hasOwn(target, name);
		if (options.replace === false && Object.keys(target).some((key) => mcpNamespace(key) === mcpNamespace(name))) {
			throw new Error("An MCP server with this name already exists. Choose another name.");
		}
		Object.defineProperty(target, name, { value: config, enumerable: true, configurable: true, writable: true });
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept; comments are not, so
 * a commented file is first saved as `<file>.bak`.
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lockTarget = canonicalPath(path);
	mkdirSync(dirname(lockTarget), { recursive: true, mode: 0o700 });
	withFileLockSync(lockTarget, (assertHeld) => {
		const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		const parsed: unknown = text === undefined ? {} : JSON.parse(stripJsonComments(stripBom(text)));
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
			throw new Error(`${path}: expected an object with an "mcpServers" object`);
		}
		const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
		if (!edit(servers, parsed)) return;
		const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
		const backup = `${path}.bak`;
		const options = { mode: 0o600, beforeCommit: assertHeld };
		// Backups can contain credentials too, including an older backup retained for uncommented input.
		if (text && hasJsonComments(text)) atomicWriteFileSync(backup, text, options);
		else if (existsSync(backup)) atomicWriteFileSync(backup, readFileSync(backup, "utf8"), options);
		atomicWriteFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`, options);
	});
}
