/** The live MCP row of the startup listing: servers start after it is drawn, so it follows their status and repaints alone. */

import { ELLIPSIS, GLYPH, SEPARATOR, type StateSource, type UiState } from "@octocodeai/octocode-tui";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { getMcpSessionStatus, MCP_STATUS_EVENT, mcpServerMayRun } from "../../../../../mcp/src/api.ts";
import { getAgentDir, getPiConfigDirs } from "../../../config.ts";
import { buildContextView, sourceSummary } from "../../../core/discovery/context-view.ts";
import { STATE_COLOR } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import type { LoadedRowSpec } from "./loaded-row.ts";

export function mcpRow(events: EventBus): LoadedRowSpec {
	const mcp = mcpStatusSource(events);
	return {
		label: "MCP",
		count: () => mcp.getState().length,
		source: mcp,
		state: () => (mcp.getState().some(mcpFailed) ? "broken" : mcp.getState().some(mcpCanStart) ? "ready" : "off"),
		summary: () => {
			const on = mcp.getState().filter(mcpCanStart);
			const off = mcp.getState().filter((s) => !mcpCanStart(s));
			return sanitizeTerminalText(
				`${on.length} on (${on.map((s) => s.name).join(", ")})${off.length ? ` · ${off.length} off (${off.map((s) => s.name).join(", ")})` : ""} · /mcp`,
			);
		},
		cells: () => ({
			sources: mcp.getState().map(mcpListed).join(theme.fg("dim", SEPARATOR)),
			tail: theme.fg("dim", sanitizeTerminalText(mcpSources(mcp.getState()))),
		}),
		expandedSummary: () => {
			const connected = mcp.getState().filter((server) => server.enabled && server.state === "connected").length;
			return theme.fg("dim", `${connected} connected · /mcp`);
		},
		details: () =>
			mcp
				.getState()
				.map(
					(server) =>
						`  ${mcpSummary(server)}${theme.fg("dim", sanitizeTerminalText(`${SEPARATOR}${server.exposure}${SEPARATOR}${server.source}`))}`,
				)
				.join("\n"),
	};
}

/** `builtin 1 · octocode global 2 · pi project 1`: where the MCP servers are defined (their names are in the row). */
function mcpSources(servers: readonly McpStatus[]): string {
	const view = buildContextView({ discovery: new Map(), mcp: servers, piRoots: getPiConfigDirs(getAgentDir()) });
	return view.groups.map((group) => sourceSummary(group, { counted: true })).join(SEPARATOR);
}

type McpStatus = ReturnType<typeof getMcpSessionStatus>[number];

/** A server that failed or dropped is news and stays in the collapsed row; connecting and connected are routine. */
const mcpFailed = (server: McpStatus): boolean =>
	server.enabled && (server.state === "failed" || server.state === "disconnected");

/** What the collapsed row draws: which servers exist, which apply and which failed, never routine connection state. */
const mcpListing = (servers: readonly McpStatus[]): string =>
	servers
		.map((server) => `${server.name}:${server.enabled}:${server.state === "unselected"}:${mcpFailed(server)}`)
		.join("\n");

/**
 * The session's MCP statuses as a state source. `getState` is live, so ctrl+o details show current states, but only a
 * change to the listing (a server appearing, or a selection) repaints the row: a connection state that moves on after
 * the row scrolled above the viewport would make the renderer clear and redraw the whole scrollback, banner included.
 */
function mcpStatusSource(events: EventBus): StateSource<readonly McpStatus[]> {
	return {
		getState: () => getMcpSessionStatus(events),
		subscribe: (listener) => {
			let listed = mcpListing(getMcpSessionStatus(events));
			return events.on(MCP_STATUS_EVENT, (servers) => {
				const next = mcpListing(servers as readonly McpStatus[]);
				if (next === listed) return;
				listed = next;
				listener();
			});
		},
	};
}

/** Server states as the design language's states; a connected server shows the presence mark instead. */
const MCP_STATE: Readonly<Record<string, UiState>> = {
	starting: "pending",
	connecting: "pending",
	"needs-auth": "waiting",
	failed: "failed",
	disconnected: "failed",
	stopped: "stopped",
	closed: "stopped",
};

/** A server this session starts: switched on, approved by the security review (`mcpServerMayRun`) and selected. */
const mcpCanStart = (server: McpStatus): boolean => mcpServerMayRun(server) && server.state !== "unselected";

/** Wording as `/mcp` uses it (`describeState`). */
const MCP_LABEL: Readonly<Record<string, string>> = {
	unselected: "not selected",
	starting: `starting${ELLIPSIS}`,
	connecting: `connecting${ELLIPSIS}`,
	"needs-auth": "needs sign-in",
};

/** The collapsed row's entry: `name`, or `○ name disabled` / `✗ name failed` for a server that does not apply or failed. Connection state is in the details. */
function mcpListed(server: McpStatus): string {
	if (mcpCanStart(server) && !mcpFailed(server)) return theme.fg("muted", sanitizeTerminalText(server.name));
	return mcpSummary(server);
}

/** `● name state`: the shared mark and colour for the server's state, then a connected server's tool count. */
function mcpSummary(server: McpStatus): string {
	const state = server.enabled ? server.state : "disabled";
	const ui = MCP_STATE[state] ?? "pending";
	const mark = state === "connected" ? theme.fg(STATE_COLOR.done, GLYPH.live) : theme.fg(STATE_COLOR[ui], GLYPH[ui]);
	const label =
		state === "connected" && server.toolCount > 0
			? `connected (${server.toolCount} tool${server.toolCount === 1 ? "" : "s"})`
			: (MCP_LABEL[state] ?? state);
	return `${mark} ${theme.fg("muted", sanitizeTerminalText(server.name))} ${theme.fg("dim", sanitizeTerminalText(label))}`;
}
