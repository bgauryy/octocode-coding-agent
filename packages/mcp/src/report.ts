/** Plain-text status of the servers: the startup report and `/mcp list` outside the TUI. */

import type { McpContext } from "./host/types.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import {
	mcpEntryRowInput,
	mcpRowFacts,
	mcpRowOrigin,
	mcpRowSummary,
	mcpServerState,
	mcpServerToolCount,
} from "./row.ts";
import { describeState, type McpServer } from "./server.ts";
import type { McpFeatureState } from "./state.ts";

/**
 * One message for everything that needs the user after startup, or only for `only`, servers
 * that connected later.
 */
export function reportProblems(state: McpFeatureState, ctx: McpContext, only?: readonly McpServer[]): void {
	const lines = only ? [] : state.configErrors.map((error) => `config: ${error}`);
	for (const server of only ?? state.servers) {
		const connectionState = server.connection?.state;
		if (connectionState === "needs-auth" || connectionState === "failed")
			lines.push(`${server.entry.name}: ${describeState(server)}`);
	}
	if (lines.length === 0 || !ctx.hasUI) return;
	ctx.ui.notify(
		`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
		"warning",
	);
}

export function formatStatus(state: McpFeatureState): string {
	const { servers, configErrors, overridden } = state;
	if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
		return `No MCP servers configured. Add them to ${state.configLocations().globalWrite} or ${state.configLocations().projectWrite}.`;
	}
	const lines = servers.map((server) => {
		const { name } = server.entry;
		const connection = server.connection;
		const facts = mcpRowFacts(
			mcpEntryRowInput(server.entry, { state: mcpServerState(server), toolCount: mcpServerToolCount(server) }),
			(file) => homeTilde(file),
		);
		const next =
			connection?.state === "needs-auth"
				? ` — run /mcp login ${name}`
				: server.entry.withheld
					? " — approve it in /security"
					: "";
		// The full error follows on its own lines.
		const error =
			connection?.error && connection.state !== "connected"
				? `\n    ${connection.error.split("\n").join("\n    ")}`
				: "";
		return `${name}: ${facts.on ? "enabled · " : ""}${mcpRowSummary(facts)} · ${mcpRowOrigin(facts)}${next}${error}`;
	});
	for (const error of configErrors) lines.push(`config error: ${error}`);
	for (const line of overridden) lines.push(`overridden: ${line}`);
	return lines.join("\n");
}
