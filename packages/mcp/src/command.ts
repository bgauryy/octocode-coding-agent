/** The `/mcp` slash command: its subcommands, argument completions, and the TUI manager entry. */

import { firstLine } from "../../common/src/clip.ts";
import type { McpCommandContext } from "./host/types.ts";
import { say } from "./notice.ts";
import type { McpExposure } from "./config.ts";
import { reconnect, signIn, signOut } from "./connections.ts";
import { exposureOf } from "./exposure.ts";
import { formatMcpConfigLocations, formatMcpTool } from "./inspection.ts";
import { manage, signInWithUi, toolCatalog } from "./manager.ts";
import { saveConfig, setExposure } from "./persistence.ts";
import { formatStatus } from "./report.ts";
import { describeState, isEnabled, type McpServer } from "./server.ts";
import { isMcpExposure, MCP_EXPOSURES } from "./servers.ts";
import type { McpExtensionState } from "./state.ts";
import { getMcpSessionStatus } from "./status.ts";
import { switchMcpServer } from "./switch.ts";
import { showMcpManager } from "./ui.ts";

/** `/mcp assign` values: every agent's default selection (`defaultActive: true`), or only agents that name the server. */
const ASSIGNMENTS = ["all", "selected"] as const;

const MCP_USAGE = `Usage: /mcp [list|config], /mcp tools [server] [tool], /mcp enable|disable <server> [--local], /mcp exposure <server> <${MCP_EXPOSURES.join("|")}> [--local], /mcp assign <server> <all|selected> [--local], /mcp login|logout [server], /mcp reconnect [server|all]`;

/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
async function pickServer(
	state: McpExtensionState,
	name: string | undefined,
	ctx: McpCommandContext,
	options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
): Promise<McpServer | undefined> {
	if (name) {
		const server = state.findServer(name);
		if (!server) say(ctx, `No MCP server named "${name}".`, "warning");
		else if (!options.eligible(server)) say(ctx, options.none, "error");
		return server && options.eligible(server) ? server : undefined;
	}
	const candidates = state.servers.filter(options.eligible);
	if (candidates.length === 0) {
		say(ctx, options.none, "info");
		return undefined;
	}
	const preferred = candidates.filter(options.preferred);
	if (candidates.length === 1) return candidates[0];
	if (preferred.length === 1) return preferred[0];
	const choice = await ctx.ui.select(
		"MCP server",
		candidates.map((server) => server.entry.name),
	);
	return candidates.find((server) => server.entry.name === choice);
}

const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
const oauthPick = {
	eligible: usesOAuth,
	preferred: (server: McpServer) => server.connection?.state === "needs-auth",
	none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
};

async function loginCommand(state: McpExtensionState, server: McpServer, ctx: McpCommandContext): Promise<void> {
	const { name } = server.entry;
	if (!ctx.hasUI) {
		say(ctx, `Signing in to MCP server "${name}" requires interactive mode.`, "error");
		return;
	}
	const { signal } = state.session;
	let failure: string | undefined;
	if (ctx.mode === "tui") {
		await showMcpManager(ctx, async (ui) => {
			failure = await signInWithUi(state, ui, server);
		});
	} else {
		failure = await signIn(state, server, {
			showAuthorizationUrl: (url) => {
				say(ctx, `Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
				state.openUrl(url.href);
			},
			promptForRedirectUrl: (signal) =>
				ctx.ui.input(
					`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
					"http://127.0.0.1:.../callback?code=...",
					{ signal },
				),
		});
	}
	// The session ended meanwhile, which cancelled the sign-in and made ctx stale.
	if (signal.aborted) return;
	if (failure) {
		say(ctx, failure, failure === "Sign-in cancelled." ? "info" : "error");
		return;
	}
	say(ctx, `Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
}

function getArgumentCompletions(state: McpExtensionState, prefix: string) {
	const { api } = state;
	const words = prefix.trimStart().split(/\s+/);
	const [action = "", name = "", value = ""] = words;
	if (words.length === 1)
		return ["list", "tools", "config", "enable", "disable", "exposure", "assign", "login", "logout", "reconnect"]
			.filter((item) => item.startsWith(action))
			.map((item) => ({ value: `${item} `, label: item }));
	if (action === "exposure" && words.length === 3)
		return MCP_EXPOSURES.filter((mode) => mode.startsWith(value)).map((mode) => ({
			value: `exposure ${name} ${mode}`,
			label: mode,
		}));
	if (action === "assign" && words.length === 3)
		return ASSIGNMENTS.filter((mode) => mode.startsWith(value)).map((mode) => ({
			value: `assign ${name} ${mode}`,
			label: mode,
		}));
	if (action === "tools") {
		if (words.length === 3)
			return toolCatalog(state, name)
				.filter((tool) => tool.name.startsWith(value))
				.map((tool) => ({
					value: `tools ${name} ${tool.name}`,
					label: tool.name,
					description: firstLine(tool.description ?? ""),
				}));
		if (words.length === 2)
			return getMcpSessionStatus(api.events)
				.filter((server) => server.name.startsWith(name))
				.map((server) => ({ value: `tools ${server.name} `, label: server.name, description: server.state }));
		return null;
	}
	if (
		words.length !== 2 ||
		!["enable", "disable", "exposure", "assign", "login", "logout", "reconnect"].includes(action)
	)
		return null;
	return state.servers
		.filter(
			(candidate) =>
				((action !== "login" && action !== "logout") || usesOAuth(candidate)) && candidate.entry.name.startsWith(name),
		)
		.map((candidate) => ({
			value: `${action} ${candidate.entry.name}${action === "exposure" || action === "assign" ? " " : ""}`,
			label: candidate.entry.name,
			description: describeState(candidate),
		}));
}

/** `/mcp tools [server] [tool]`. */
function showToolsCommand(state: McpExtensionState, name: string, extra: string[], ctx: McpCommandContext): void {
	if (extra.length > 1) {
		say(ctx, MCP_USAGE, "warning");
		return;
	}
	const snapshot = getMcpSessionStatus(state.api.events).filter((server) => !name || server.name === name);
	if (name && snapshot.length === 0) {
		say(ctx, `No MCP server named "${name}".`, "warning");
		return;
	}
	const toolName = extra[0];
	if (toolName) {
		const tool = toolCatalog(state, name).find((candidate) => candidate.name === toolName);
		say(
			ctx,
			tool ? formatMcpTool(tool, true) : `No available tool named "${toolName}" on MCP server "${name}".`,
			tool ? "info" : "warning",
		);
	} else
		say(
			ctx,
			snapshot
				.map((server) =>
					[
						`${server.name}: ${server.enabled ? server.state : "disabled"}`,
						...toolCatalog(state, server.name).map((tool) => `  ${formatMcpTool(tool)}`),
						...(toolCatalog(state, server.name).length ? [] : ["  No tools available in the current connection."]),
					].join("\n"),
				)
				.join("\n\n") || "No MCP servers configured. Use /mcp config to see configuration locations.",
			"info",
		);
}

/**
 * `/mcp enable|disable <server> [--local]`, `/mcp exposure <server> <mode> [--local]` and
 * `/mcp assign <server> <all|selected> [--local]` (`defaultActive`; it decides which sessions start the server, so it
 * applies from the next session).
 */
async function configureCommand(
	state: McpExtensionState,
	action: "enable" | "disable" | "exposure" | "assign",
	name: string,
	extra: string[],
	ctx: McpCommandContext,
): Promise<void> {
	const mode = action === "exposure" || action === "assign" ? extra.shift() : undefined;
	const inProject = extra.length === 1 && (extra[0] === "--local" || extra[0] === "-l");
	if (
		!name ||
		(extra.length > 0 && !inProject) ||
		(action === "exposure" && !isMcpExposure(mode)) ||
		(action === "assign" && !ASSIGNMENTS.some((value) => value === mode))
	) {
		say(ctx, MCP_USAGE, "warning");
		return;
	}
	if (action === "enable" || action === "disable") {
		const result = await switchMcpServer(state, { name, enabled: action === "enable", inProject });
		say(ctx, result.message, result.ok ? "info" : state.findServer(name) ? "error" : "warning");
		return;
	}
	const server = state.findServer(name);
	if (!server) {
		say(ctx, `No MCP server named "${name}".`, "warning");
		return;
	}
	const failure =
		action === "exposure"
			? setExposure(state, server, mode as McpExposure, inProject)
			: saveConfig(state, server, { defaultActive: mode === "all" }, inProject);
	// Where the change was written: the override file, the definition file, or nowhere for a session-only server.
	const saved = server.entry.scope === "extension" ? "this session" : (server.entry.override ?? server.entry.source);
	if (failure) say(ctx, failure, "error");
	else if (action === "assign") {
		say(
			ctx,
			mode === "all"
				? `${name}: in every agent's default tool selection from the next session. Saved to ${saved}.`
				: `${name}: only agents whose tools name mcp__${name}__ get it, from the next session. Saved to ${saved}.`,
			"info",
		);
	} else {
		say(
			ctx,
			`${name}: ${isEnabled(server) ? "enabled" : "disabled"} · ${describeState(server, false)} · ${exposureOf(server.entry)}. Saved to ${saved}.`,
			"info",
		);
	}
}

/** `/mcp reconnect [server|all]`. */
async function reconnectCommand(state: McpExtensionState, name: string, ctx: McpCommandContext): Promise<void> {
	if (name === "all") {
		const targets = state.servers
			.filter((server) => server.connection)
			.map((server) => ({ name: server.entry.name, run: () => reconnect(server) }));
		if (targets.length === 0) return say(ctx, "No enabled MCP server to reconnect.", "info");
		const failures = (
			await Promise.all(targets.map(async (target) => ({ name: target.name, failure: await target.run() })))
		).filter((result) => result.failure);
		if (state.session.signal.aborted) return;
		say(
			ctx,
			failures.length
				? `Reconnected ${targets.length - failures.length} of ${targets.length} MCP servers. ${failures.map((result) => `${result.name}: ${result.failure}`).join("; ")}`
				: `Reconnected ${targets.length} MCP server${targets.length === 1 ? "" : "s"}.`,
			failures.length ? "error" : "info",
		);
		return;
	}
	const server = await pickServer(state, name, ctx, {
		eligible: (candidate) => candidate.connection !== undefined,
		preferred: (candidate) =>
			candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
		none: "No enabled MCP server to reconnect.",
	});
	if (!server) return;
	const failure = await reconnect(server);
	if (failure) say(ctx, failure, "error");
	else {
		say(ctx, `Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`, "info");
	}
}

export function registerMcpCommand(state: McpExtensionState): void {
	state.api.registerCommand("mcp", {
		description: "Manage MCP servers and their tools",
		getArgumentCompletions: (prefix) => getArgumentCompletions(state, prefix),
		handler: async (args, ctx) => {
			const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (action === undefined) {
				if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(state, ui, ctx));
				else {
					await state.pending;
					say(ctx, formatStatus(state), "info");
				}
				return;
			}
			if (action === "list") {
				say(ctx, name ? MCP_USAGE : formatStatus(state), name ? "warning" : "info");
				return;
			}
			if (action === "config") {
				say(ctx, name ? MCP_USAGE : formatMcpConfigLocations(state.configLocations()), name ? "warning" : "info");
				return;
			}
			if (action === "tools") {
				showToolsCommand(state, name, extra, ctx);
				return;
			}
			if (action === "enable" || action === "disable" || action === "exposure" || action === "assign") {
				await configureCommand(state, action, name, extra, ctx);
				return;
			}
			if (extra.length > 0) {
				say(ctx, MCP_USAGE, "warning");
				return;
			}
			await state.pending;
			switch (action) {
				case "login": {
					const server = await pickServer(state, name, ctx, oauthPick);
					if (server) await loginCommand(state, server, ctx);
					return;
				}
				case "logout": {
					const server = await pickServer(state, name, ctx, oauthPick);
					if (!server) return;
					const removed = await signOut(state, server);
					say(
						ctx,
						removed
							? `Signed out of MCP server "${server.entry.name}".`
							: `No stored credentials for MCP server "${server.entry.name}".`,
						"info",
					);
					return;
				}
				case "reconnect":
					return reconnectCommand(state, name, ctx);
				default:
					say(ctx, MCP_USAGE, "warning");
			}
		},
	});
}
