/** Plain-text status of the servers: the startup report and `/mcp list` outside the TUI. */

import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { exposureOf } from "./exposure.ts";
import { describeState, isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";

/**
 * One message for everything that needs the user after startup, or only for `only`, servers
 * that connected later.
 */
export function reportProblems(state: McpExtensionState, ctx: ExtensionContext, only?: readonly McpServer[]): void {
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

export function formatStatus(state: McpExtensionState): string {
	const { servers, configErrors, overridden } = state;
	if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
		return `No MCP servers configured. Add them to ${state.configLocations().globalWrite} or ${state.configLocations().projectWrite}.`;
	}
	const lines = servers.map((server) => {
		const { name } = server.entry;
		const exposure = exposureOf(server.entry);
		const connection = server.connection;
		if (connection?.state === "needs-auth") return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
		const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
		const label = connection?.isStopped
			? "stopped"
			: !isEnabled(server)
				? "disabled"
				: connection?.state === "disconnected"
					? "disconnected, reconnects on next call"
					: (connection?.state ?? "starting");
		const error =
			connection?.error && connection.state !== "connected"
				? `\n    ${connection.error.split("\n").join("\n    ")}`
				: "";
		return `${name}: ${isEnabled(server) ? "enabled · " : ""}${label}${tools} (${exposure})${error}`;
	});
	for (const error of configErrors) lines.push(`config error: ${error}`);
	for (const line of overridden) lines.push(`overridden: ${line}`);
	return lines.join("\n");
}
