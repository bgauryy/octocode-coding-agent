/**
 * The writes behind a per-tool MCP pin and the `Available to` choice, shared by `/harness` and the web Tools panel so
 * both reach the same file the way `octocode mcp enable` does (`switchTarget`).
 */

import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { updateMcpServerConfig } from "../../../../mcp/src/api.ts";
import type { ConfigContext } from "../types.ts";
import { loadMcpServers, switchTarget } from "./mcp.ts";

/** What a pin or an `Available to` change tells the user: sessions that already started keep what they declared. */
export const NEXT_SESSION = "It applies from the next session; running sessions keep what they declared.";

type McpServerPatch = Exclude<Parameters<typeof updateMcpServerConfig>[2], (...args: never[]) => unknown>;

/** The scope a change is written for; the file is the one `switchTarget` picks for it. */
export type McpWriteScope = "global" | "project";

/** Thrown when no configuration file defines or can override the server. */
export class UnknownMcpServerError extends Error {
	readonly server: string;
	constructor(server: string) {
		super(`No MCP server named "${server}" in a configuration file.`);
		this.server = server;
	}
}

/**
 * Applies `patch` to the server's entry in the file `switchTarget` picks and answers with that file. A server defined
 * elsewhere (another agent's file, a built-in) gets an override entry in Octocode's own file instead. Project scope
 * needs a trusted folder.
 */
function patchMcpServer(
	ctx: ConfigContext,
	scope: McpWriteScope,
	server: string,
	patch: (entry: { toolExposure: Record<string, McpExposure> }) => McpServerPatch,
): string {
	if (scope === "project" && !ctx.projectTrusted)
		throw new Error("This project is not trusted, so its MCP configuration cannot be changed.");
	const loaded = loadMcpServers(ctx);
	const entry = loaded.servers.find((candidate) => candidate.name === server);
	if (!entry) throw new UnknownMcpServerError(server);
	const target = switchTarget(entry, loaded, scope, ctx);
	// Built from the file's own pins while its lock is held, so a pin another session wrote meanwhile is kept. An entry
	// without pins of its own (a fresh override) starts from the pins the loaded server has.
	updateMcpServerConfig(
		target,
		entry.name,
		(current) =>
			patch({
				toolExposure: isRecord(current?.toolExposure)
					? { ...(current.toolExposure as Record<string, McpExposure>) }
					: { ...entry.config.toolExposure },
			}),
		{ override: target !== entry.source },
	);
	return target;
}

/**
 * Pins one tool of a server, or removes its pin (`null`). The whole map is written: an override's `toolExposure`
 * replaces the one of the server it overrides. Answers with the file written.
 */
export function pinMcpTool(
	ctx: ConfigContext,
	scope: McpWriteScope,
	server: string,
	tool: string,
	pin: McpExposure | null,
): string {
	return patchMcpServer(ctx, scope, server, ({ toolExposure }) => {
		if (pin === null) delete toolExposure[tool];
		else toolExposure[tool] = pin;
		return { toolExposure };
	});
}

/**
 * The server's `exposure`: what its tools get unless a pin or pattern in `toolExposure` says otherwise. Answers with the
 * file written.
 */
export function setMcpExposure(
	ctx: ConfigContext,
	scope: McpWriteScope,
	server: string,
	exposure: McpExposure,
): string {
	return patchMcpServer(ctx, scope, server, () => ({ exposure }));
}

/**
 * `defaultActive`: whether the server's tools are in every agent's default tool selection (`true`) or only in agents
 * whose profile `tools:` names `mcp__<server>__`. Answers with the file written.
 */
export function setMcpDefaultActive(
	ctx: ConfigContext,
	scope: McpWriteScope,
	server: string,
	everyAgent: boolean,
): string {
	return patchMcpServer(ctx, scope, server, () => ({ defaultActive: everyAgent }));
}
