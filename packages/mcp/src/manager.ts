/** The `/mcp` manager in the TUI: server list, server actions, tools, exposure and sign-in screens. */

import type { SelectItem } from "@octocodeai/octocode-tui";
import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import type { McpExposure } from "./config.ts";
import { reconnect, setEnabled, signIn, signOut } from "./connections.ts";
import { exposureOf } from "./exposure.ts";
import { formatMcpTool, toolCatalog } from "./inspection.ts";

export { toolCatalog } from "./inspection.ts";
import { errorMessage } from "../../coding-agent/src/utils/guards.ts";
import { setExposure } from "./persistence.ts";
import {
	attentionRank,
	describeState,
	describeTransport,
	EXPOSURE_DESCRIPTIONS,
	firstLine,
	isEnabled,
	type McpServer,
} from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { ensureDiscoveryActive } from "./tool-registry.ts";
import type { McpMenu, McpUi } from "./ui.ts";

function notices(state: McpExtensionState): string[] {
	return [
		...state.configErrors.map((error) => `config: ${error}`),
		...state.overridden.map((line) => `overridden: ${line}`),
	];
}

function serversMenu(state: McpExtensionState): McpMenu {
	const { projectTrusted } = state;
	return {
		title: "MCP servers",
		details: `Global: ${state.configLocations().globalWrite}\nWorkspace: ${state.configLocations().projectWrite}${projectTrusted ? "" : " (requires trust)"}\n/mcp config shows read order; /mcp tools lists tools.`,
		error: notices(state).join("\n") || undefined,
		items: [...state.servers]
			.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
			.map((server) => ({
				value: server.entry.name,
				label: server.entry.name,
				description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? `global, ${server.entry.overrideScope ?? "project"} override` : (server.entry.scope ?? server.entry.source)}`,
			})),
		empty: `No MCP servers configured. Add them to ${state.configLocations().globalWrite} or ${state.configLocations().projectWrite}.`,
		confirmLabel: "manage",
		cancelLabel: "close",
	};
}

function serverMenu(state: McpExtensionState, name: string): McpMenu {
	const { projectConfig } = state;
	const server = state.findServer(name);
	if (!server) {
		return {
			title: name,
			items: [],
			empty: "This server is no longer configured.",
			confirmLabel: "",
			cancelLabel: "back",
		};
	}
	const { entry, connection } = server;
	const saved = entry.scope === "extension" ? "for this session" : `saved to ${state.configPath(entry)}`;
	// Global servers without an override can be turned on or off for the trusted project alone.
	const inProject =
		(entry.scope === "global" || entry.scope === "default") &&
		(!entry.override || entry.overrideScope === "global") &&
		projectConfig !== undefined;
	const inProjectSaved = `saved to ${projectConfig}`;
	const items: SelectItem[] = [];
	if (!isEnabled(server)) {
		items.push({ value: "enable", label: "Enable", description: saved });
		if (inProject) {
			items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
		}
	} else {
		const connectionState = connection?.state;
		if (connectionState === "needs-auth")
			items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
		if (connectionState === "connected" && connection) {
			items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
		}
		if (
			connectionState === "failed" ||
			connectionState === "disconnected" ||
			connectionState === "connected" ||
			connectionState === "needs-auth"
		) {
			items.push({ value: "reconnect", label: "Reconnect" });
		}
		if (connectionState === "connected" && connection?.oauthUrl) {
			items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
		}
		items.push({ value: "disable", label: "Disable", description: saved });
		if (inProject) {
			items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
		}
	}
	items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
	const details = [
		describeTransport(entry),
		`${entry.scope ?? "config"}: ${entry.source}`,
		...(entry.override ? [`${entry.overrideScope ?? "project"} override: ${entry.override}`] : []),
		`State: ${describeState(server, false)}`,
	];
	const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	return {
		title: `MCP server ${name}`,
		details: details.join("\n"),
		error: error || undefined,
		items,
		selected: items[0]?.value,
		confirmLabel: "select",
		cancelLabel: "back",
	};
}

async function showTools(state: McpExtensionState, ui: McpUi, name: string): Promise<void> {
	for (;;) {
		const selected = await ui.menu(
			() => ({
				title: `Tools of ${name}`,
				details: "Select a tool to inspect its description and input schema. Hidden tools cannot be called.",
				items: toolCatalog(state, name).map((tool) => ({
					value: tool.name,
					label: tool.name,
					description: `[${tool.exposure}] ${firstLine(tool.description ?? "")}`,
				})),
				empty: "No tools available. The server may be disabled, disconnected, or offer no tools.",
				confirmLabel: "inspect",
				cancelLabel: "back",
			}),
			state.subscribe,
		);
		if (!selected) return;
		const tool = toolCatalog(state, name).find((candidate) => candidate.name === selected);
		if (tool)
			await ui.menu(() => ({
				title: `Tool ${tool.name}`,
				details: formatMcpTool(tool, true),
				items: [],
				confirmLabel: "",
				cancelLabel: "back",
			}));
	}
}

async function chooseExposure(state: McpExtensionState, ui: McpUi, server: McpServer): Promise<string | undefined> {
	const current = exposureOf(server.entry);
	const choice = await ui.menu(() => ({
		title: `Exposure of ${server.entry.name}`,
		details:
			server.entry.scope === "extension"
				? `Applies to this session; the server is registered by ${server.entry.source}.`
				: `Saved to ${state.configPath(server.entry)}.`,
		items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
			value: exposure,
			label: `${exposure === current ? "✓ " : "  "}${exposure}`,
			description: EXPOSURE_DESCRIPTIONS[exposure],
		})),
		selected: current,
		confirmLabel: "save",
		cancelLabel: "back",
	}));
	if (!choice || choice === current) return undefined;
	return setExposure(state, server, choice as McpExposure);
}

/** Sign in with the manager view's sign-in screen, which shows the URL with a copy key and cancels with Esc. */
export function signInWithUi(state: McpExtensionState, ui: McpUi, server: McpServer): Promise<string | undefined> {
	const title = `Sign in to ${server.entry.name}`;
	const cancel = new AbortController();
	const status = (message: string) => ui.status(title, message, () => cancel.abort());
	let authorizationUrl = "";
	status("Contacting the authorization server…");
	return signIn(
		state,
		server,
		{
			showAuthorizationUrl: (url) => {
				authorizationUrl = url.href;
				state.openUrl(url.href);
			},
			promptForRedirectUrl: async (signal) => {
				const value = await ui.redirectUrl(title, authorizationUrl, signal);
				status("Connecting…");
				return value;
			},
		},
		cancel.signal,
	);
}

/** Keep the subscribed menu usable while a connection opens or closes. */
function runInBackground(
	state: McpExtensionState,
	ctx: ExtensionContext,
	server: McpServer,
	operation: () => Promise<string | undefined>,
): void {
	const ready = operation();
	const attempt = server.attempt;
	const { signal } = state.session;
	const finish = (message: string | undefined) => {
		if (signal.aborted || server.attempt !== attempt || !state.servers.includes(server)) return;
		server.message = message;
		ensureDiscoveryActive(state, ctx);
		state.emitChange();
	};
	void state.track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
}

async function runAction(
	state: McpExtensionState,
	ui: McpUi,
	ctx: ExtensionContext,
	server: McpServer,
	action: string,
): Promise<void> {
	const { signal } = state.session;
	let message: string | undefined;
	switch (action) {
		case "signin":
			message = await signInWithUi(state, ui, server);
			break;
		case "reconnect":
			// Connection state and error already report failures, including required sign-ins.
			runInBackground(state, ctx, server, async () => {
				await reconnect(server);
				return undefined;
			});
			break;
		case "signout":
			await signOut(state, server);
			break;
		case "tools":
			await showTools(state, ui, server.entry.name);
			break;
		case "exposure":
			message = await chooseExposure(state, ui, server);
			break;
		case "enable":
		case "disable":
		case "enable-project":
		case "disable-project": {
			const enable = action.startsWith("enable");
			runInBackground(state, ctx, server, () => setEnabled(state, server, enable, action.endsWith("-project")));
			break;
		}
	}
	// The session ended meanwhile (for example during a sign-in), which made ctx stale.
	if (signal.aborted) return;
	server.message = message;
	ensureDiscoveryActive(state, ctx);
	state.emitChange();
}

export async function manage(state: McpExtensionState, ui: McpUi, ctx: ExtensionContext): Promise<void> {
	for (;;) {
		const name = await ui.menu(() => serversMenu(state), state.subscribe);
		if (!name) return;
		for (;;) {
			const action = await ui.menu(() => serverMenu(state, name), state.subscribe);
			const server = state.findServer(name);
			if (!action) break;
			if (server) await runAction(state, ui, ctx, server, action);
			else break;
		}
	}
}
