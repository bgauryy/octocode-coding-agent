/**
 * The facts of one MCP server row, worded once: `/mcp list`, `/harness` and `/settings list mcp` render from these,
 * each in its own layout. Pure: it reads no file and no session.
 */

import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
import type { McpServerEntry } from "./config.ts";
import { exposureOf } from "./exposure.ts";
import { mcpGroupLabel, mcpServerGroup, mcpServerSource } from "./group.ts";
import { isEnabled, type McpServer, WITHHELD_STATE } from "./server.ts";

/** Who gets the server's tools by default: `defaultActive` as the rows word it. */
type McpAvailableTo = "every agent" | "only agents that name it";

/** What a row reads of a server. `state` is the session's state word (`mcpServerState`); absent when no session reports it. */
export interface McpRowInput {
	name: string;
	/** The server's own `enabled` switch. */
	enabled: boolean;

	state?: string;
	toolCount?: number;
	exposure: McpExposure;
	/** `defaultActive`; absent counts as true. */
	defaultActive?: boolean;
	scope?: McpServerEntry["scope"];
	source: string;
}

export interface McpRowFacts {
	name: string;
	on: boolean;
	/** The connection state as a row words it, `not connected` when no session reports one. */
	state: string;
	toolCount: number;
	exposure: McpExposure;
	availableTo: McpAvailableTo;
	/** `Core`, `Workspace` or `Global`. */
	group: string;
	/** `built in`, `plugin <file>` or the file, shortened by the caller's `short`. */
	source: string;
}

const STATE_LABELS: Readonly<Record<string, string>> = {
	"not checked": WITHHELD_STATE,
	"needs-auth": "needs sign-in",
	unselected: "not selected",
	disconnected: "disconnected, reconnects on next call",
};

/** The state word a session publishes for a server (`McpServerStatus.state`). */
export function mcpServerState(server: McpServer): string {
	if (server.entry.withheld) return "not checked";
	if (!isEnabled(server)) return "disabled";
	if (server.unselected) return "unselected";
	if (server.connection?.isStopped) return "stopped";
	return server.connection?.state ?? "starting";
}

/** How many tools a session lists for the server: its connection's, else none. */
export const mcpServerToolCount = (server: McpServer): number =>
	server.connection?.state === "connected" ? server.connection.tools.length : 0;

/** The row input of a configured server, with what a session reports of it when there is one. */
export function mcpEntryRowInput(entry: McpServerEntry, live?: { state: string; toolCount: number }): McpRowInput {
	return {
		name: entry.name,
		enabled: entry.config.enabled !== false,
		// Off until approved, whatever its switch: worded so even where no session reports a state.
		...(entry.withheld ? { state: "not checked" } : {}),
		exposure: exposureOf(entry),
		defaultActive: entry.config.defaultActive !== false,
		...(entry.scope ? { scope: entry.scope } : {}),
		source: entry.source,
		...live,
	};
}

export function mcpRowFacts(input: McpRowInput, short?: (file: string) => string): McpRowFacts {
	const scope = input.scope;
	return {
		name: input.name,
		// The switch, which `/harness` and `/settings` toggle; a held-back server's state says it is off until approved.
		on: input.enabled,
		state: input.state === undefined ? "not connected" : (STATE_LABELS[input.state] ?? input.state),
		toolCount: input.toolCount ?? 0,
		exposure: input.exposure,
		availableTo: input.defaultActive === false ? "only agents that name it" : "every agent",
		group: mcpGroupLabel(mcpServerGroup({ scope })),
		source: mcpServerSource({ scope, source: input.source }, short),
	};
}

/** `connected · 14 tools · direct · every agent`: the facts that follow the row's name on every surface. */
export function mcpRowSummary(facts: McpRowFacts): string {
	return [
		facts.state,
		`${facts.toolCount} tool${facts.toolCount === 1 ? "" : "s"}`,
		facts.exposure,
		facts.availableTo,
	].join(" · ");
}

/** `Core · built in`: where the server comes from. */
export const mcpRowOrigin = (facts: McpRowFacts): string => `${facts.group} · ${facts.source}`;
