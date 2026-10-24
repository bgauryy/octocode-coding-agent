/** The `/mcp` slash command: its subcommands, argument completions, and the TUI manager entry. */

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { McpExposure } from "./config.ts";
import { reconnect, setEnabled, signIn, signOut } from "./connections.ts";
import { exposureOf } from "./exposure.ts";
import { formatMcpConfigLocations, formatMcpTool } from "./inspection.ts";
import { manage, signInWithUi, toolCatalog } from "./manager.ts";
import { setExposure } from "./persistence.ts";
import { formatStatus } from "./report.ts";
import { describeState, EXPOSURE_DESCRIPTIONS, firstLine, isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { getMcpReconnect, getMcpSessionStatus } from "./status.ts";
import { ensureDiscoveryActive } from "./tool-registry.ts";
import { showMcpManager } from "./ui.ts";

const MCP_USAGE =
	"Usage: /mcp [list|config], /mcp tools [server] [tool], /mcp enable|disable <server> [--local], /mcp exposure <server> <auto|deferred|direct|hidden> [--local], /mcp login|logout [server], /mcp reconnect [server|all]";

/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
async function pickServer(
	state: McpExtensionState,
	name: string | undefined,
	ctx: ExtensionCommandContext,
	options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
): Promise<McpServer | undefined> {
	if (name) {
		const server = state.findServer(name);
		if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
		else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
		return server && options.eligible(server) ? server : undefined;
	}
	const candidates = state.servers.filter(options.eligible);
	if (candidates.length === 0) {
		ctx.ui.notify(options.none, "info");
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

async function loginCommand(state: McpExtensionState, server: McpServer, ctx: ExtensionCommandContext): Promise<void> {
	const { name } = server.entry;
	if (!ctx.hasUI) {
		ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
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
				ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
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
		ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
		return;
	}
	ensureDiscoveryActive(state, ctx);
	ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
}

function getArgumentCompletions(state: McpExtensionState, prefix: string) {
	const { pi } = state;
	const words = prefix.trimStart().split(/\s+/);
	const [action = "", name = "", value = ""] = words;
	if (words.length === 1)
		return ["list", "tools", "config", "enable", "disable", "exposure", "login", "logout", "reconnect"]
			.filter((item) => item.startsWith(action))
			.map((item) => ({ value: `${item} `, label: item }));
	if (action === "exposure" && words.length === 3)
		return Object.keys(EXPOSURE_DESCRIPTIONS)
			.filter((mode) => mode.startsWith(value))
			.map((mode) => ({ value: `exposure ${name} ${mode}`, label: mode }));
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
			return getMcpSessionStatus(pi.events)
				.filter((server) => server.name.startsWith(name))
				.map((server) => ({ value: `tools ${server.name} `, label: server.name, description: server.state }));
		return null;
	}
	if (words.length !== 2 || !["enable", "disable", "exposure", "login", "logout", "reconnect"].includes(action))
		return null;
	return state.servers
		.filter(
			(candidate) =>
				((action !== "login" && action !== "logout") || usesOAuth(candidate)) && candidate.entry.name.startsWith(name),
		)
		.map((candidate) => ({
			value: `${action} ${candidate.entry.name}${action === "exposure" ? " " : ""}`,
			label: candidate.entry.name,
			description: describeState(candidate),
		}))
		.concat(
			action === "reconnect"
				? getMcpSessionStatus(pi.events)
						.filter(
							(candidate) =>
								!state.findServer(candidate.name) &&
								candidate.name.startsWith(name) &&
								getMcpReconnect(pi.events, candidate.name),
						)
						.map((candidate) => ({
							value: `reconnect ${candidate.name}`,
							label: candidate.name,
							description: candidate.state,
						}))
				: [],
		);
}

/** `/mcp tools [server] [tool]`. */
function showToolsCommand(state: McpExtensionState, name: string, extra: string[], ctx: ExtensionCommandContext): void {
	if (extra.length > 1) {
		ctx.ui.notify(MCP_USAGE, "warning");
		return;
	}
	const snapshot = getMcpSessionStatus(state.pi.events).filter((server) => !name || server.name === name);
	if (name && snapshot.length === 0) {
		ctx.ui.notify(`No MCP server named "${name}".`, "error");
		return;
	}
	const toolName = extra[0];
	if (toolName) {
		const tool = toolCatalog(state, name).find((candidate) => candidate.name === toolName);
		ctx.ui.notify(
			tool ? formatMcpTool(tool, true) : `No available tool named "${toolName}" on MCP server "${name}".`,
			tool ? "info" : "warning",
		);
	} else
		ctx.ui.notify(
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

/** `/mcp enable|disable <server> [--local]` and `/mcp exposure <server> <mode> [--local]`. */
async function configureCommand(
	state: McpExtensionState,
	action: "enable" | "disable" | "exposure",
	name: string,
	extra: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	const mode = action === "exposure" ? extra.shift() : undefined;
	const inProject = extra.length === 1 && (extra[0] === "--local" || extra[0] === "-l");
	if (
		!name ||
		(extra.length > 0 && !inProject) ||
		(action === "exposure" && !Object.hasOwn(EXPOSURE_DESCRIPTIONS, mode ?? ""))
	) {
		ctx.ui.notify(MCP_USAGE, "warning");
		return;
	}
	const server = state.findServer(name);
	if (!server) {
		const automatic = getMcpSessionStatus(state.pi.events).some((candidate) => candidate.name === name);
		ctx.ui.notify(
			automatic
				? `MCP server "${name}" is automatic. Add an explicit ${name} transport entry to ${state.configLocations().globalWrite} to persist enablement or exposure. /mcp config shows other locations. /mcp reconnect octocode restarts automatic Octocode; OCTOCODE_MCP=0 disables it at startup.`
				: `No MCP server named "${name}".`,
			"error",
		);
		return;
	}
	const failure =
		action === "exposure"
			? setExposure(state, server, mode as McpExposure, inProject)
			: await state.track(setEnabled(state, server, action === "enable", inProject));
	if (failure) ctx.ui.notify(failure, "error");
	else {
		ensureDiscoveryActive(state, ctx);
		const saved = server.entry.scope === "extension" ? "this session" : (server.entry.override ?? server.entry.source);
		ctx.ui.notify(
			`${name}: ${isEnabled(server) ? "enabled" : "disabled"} · ${describeState(server, false)} · ${exposureOf(server.entry)}. Saved to ${saved}.`,
			"info",
		);
	}
}

/** `/mcp reconnect [server|all]`. */
async function reconnectCommand(state: McpExtensionState, name: string, ctx: ExtensionCommandContext): Promise<void> {
	const { pi } = state;
	if (name === "all") {
		const owners = getMcpSessionStatus(pi.events)
			.filter((candidate) => !state.findServer(candidate.name))
			.flatMap((candidate) => {
				const owner = getMcpReconnect(pi.events, candidate.name);
				return owner ? [{ name: candidate.name, run: () => owner(ctx) }] : [];
			});
		const targets = [
			...state.servers
				.filter((server) => server.connection)
				.map((server) => ({ name: server.entry.name, run: () => reconnect(server) })),
			...owners,
		];
		if (targets.length === 0) return ctx.ui.notify("No enabled MCP server to reconnect.", "info");
		const failures = (
			await Promise.all(targets.map(async (target) => ({ name: target.name, failure: await target.run() })))
		).filter((result) => result.failure);
		if (state.session.signal.aborted) return;
		ensureDiscoveryActive(state, ctx);
		ctx.ui.notify(
			failures.length
				? `Reconnected ${targets.length - failures.length} of ${targets.length} MCP servers. ${failures.map((result) => `${result.name}: ${result.failure}`).join("; ")}`
				: `Reconnected ${targets.length} MCP server${targets.length === 1 ? "" : "s"}.`,
			failures.length ? "error" : "info",
		);
		return;
	}
	let target: string | undefined = name;
	const automatic = getMcpSessionStatus(pi.events).filter(
		(candidate) => !state.findServer(candidate.name) && getMcpReconnect(pi.events, candidate.name),
	);
	if (!target && automatic.length) {
		const candidates = [
			...state.servers.filter((server) => server.connection).map((server) => server.entry.name),
			...automatic.map((server) => server.name),
		];
		target = candidates.length === 1 ? candidates[0] : await ctx.ui.select("MCP server", candidates);
		if (!target) return;
	}
	if (target && !state.findServer(target)) {
		const reconnect = getMcpReconnect(pi.events, target);
		if (reconnect && automatic.some((server) => server.name === target)) {
			const failure = await reconnect(ctx);
			if (state.session.signal.aborted) return;
			ctx.ui.notify(failure ?? `Reconnected to MCP server "${target}".`, failure ? "error" : "info");
			return;
		}
	}
	const server = await pickServer(state, target, ctx, {
		eligible: (candidate) => candidate.connection !== undefined,
		preferred: (candidate) =>
			candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
		none: "No enabled MCP server to reconnect.",
	});
	if (!server) return;
	const failure = await reconnect(server);
	if (failure) ctx.ui.notify(failure, "error");
	else {
		ensureDiscoveryActive(state, ctx);
		ctx.ui.notify(`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`, "info");
	}
}

export function registerMcpCommand(state: McpExtensionState): void {
	state.pi.registerCommand("mcp", {
		description:
			"Manage MCP servers, inspect tools and configuration, sign in, reconnect, or change enablement and exposure",
		getArgumentCompletions: (prefix) => getArgumentCompletions(state, prefix),
		handler: async (args, ctx) => {
			const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (action === undefined) {
				if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(state, ui, ctx));
				else {
					await state.pending;
					ctx.ui.notify(formatStatus(state), "info");
				}
				return;
			}
			if (action === "list") {
				ctx.ui.notify(name ? MCP_USAGE : formatStatus(state), name ? "warning" : "info");
				return;
			}
			if (action === "config") {
				ctx.ui.notify(name ? MCP_USAGE : formatMcpConfigLocations(state.configLocations()), name ? "warning" : "info");
				return;
			}
			if (action === "tools") {
				showToolsCommand(state, name, extra, ctx);
				return;
			}
			if (action === "enable" || action === "disable" || action === "exposure") {
				await configureCommand(state, action, name, extra, ctx);
				return;
			}
			if (extra.length > 0) {
				ctx.ui.notify(MCP_USAGE, "warning");
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
					ctx.ui.notify(
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
					ctx.ui.notify(MCP_USAGE, "warning");
			}
		},
	});
}
