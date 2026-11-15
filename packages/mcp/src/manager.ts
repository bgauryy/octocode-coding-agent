/** The `/mcp` manager in the TUI: server list, server actions, tools and sign-in screens. */

import { addMcpWithUi } from "./add-ui.ts";
import type { SelectItem } from "@octocodeai/octocode-tui";
import { firstLine } from "../../common/src/clip.ts";
import type { McpContext } from "./host/types.ts";
import { hostPaths } from "./host.ts";
import { reconnect, signIn, signOut } from "./connections.ts";
import { exposureOf } from "./exposure.ts";
import { formatMcpTool, toolCatalog } from "./inspection.ts";

export { toolCatalog } from "./inspection.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { attentionRank, describeState, describeTransport, isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpMenu, McpMenuItem, McpUi } from "./ui.ts";

function notices(state: McpExtensionState): string[] {
	return [
		...state.configErrors.map((error) => `config: ${error}`),
		...state.overridden.map((line) => `overridden: ${line}`),
	];
}

/** The badge colour of a server's state: success when connected, error when failed, warning when it needs the user. */
function stateTone(server: McpServer): McpMenuItem["tone"] {
	if (!isEnabled(server)) return "muted";
	switch (server.connection?.state) {
		case "connected":
			return "success";
		case "failed":
			return "error";
		case "needs-auth":
			return "warning";
		default:
			return "muted";
	}
}

function serversMenu(state: McpExtensionState): McpMenu {
	const { projectTrusted } = state;
	return {
		title: "MCP servers — connect, sign in, inspect tools, add",
		heading: "Servers",
		details: `Global: ${state.configLocations().globalWrite}\nWorkspace: ${state.configLocations().projectWrite}${projectTrusted ? "" : " (requires trust)"}\n/mcp add saves a new server; /mcp config shows read order; /mcp tools lists tools.`,
		error: notices(state).join("\n") || undefined,
		items: [
			...[...state.servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${exposureOf(server.entry)} · ${server.entry.override ? `global, ${server.entry.overrideScope ?? "project"} override` : (server.entry.scope ?? server.entry.source)}`,
					badge: describeState(server, false),
					tone: stateTone(server),
				})),
			{ value: "@add", label: "Add MCP", description: "Save a new stdio or HTTP definition, off until reviewed" },
		],
		empty: `No MCP servers configured. Add them to ${state.configLocations().globalWrite} or ${state.configLocations().projectWrite}.`,
		confirmLabel: "open",
		cancelLabel: "close",
	};
}

function serverMenu(state: McpExtensionState, name: string): McpMenu {
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
	const items: SelectItem[] = [];
	if (isEnabled(server)) {
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
	}
	const facts = [
		{ label: "Transport", value: describeTransport(entry) },
		{ label: "Exposure", value: `${exposureOf(entry)} · change in /harness mcp` },
		{ label: entry.scope ?? "config", value: entry.source },
		...(entry.override ? [{ label: `${entry.overrideScope ?? "project"} override`, value: entry.override }] : []),
		{ label: "State", value: isEnabled(server) ? describeState(server, false) : "Off · turn on in /harness mcp" },
		// What the server last warned about and the last protocol error, which otherwise only reach mcp.log.
		...(connection?.serverWarning ? [{ label: "Server log", value: connection.serverWarning }] : []),
		...(connection?.clientError ? [{ label: "Client error", value: connection.clientError }] : []),
	];
	const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	return {
		title: `${name} — MCP server`,
		heading: "Actions",
		facts,
		error: error || undefined,
		items,
		selected: items[0]?.value,
		confirmLabel: "run",
		cancelLabel: "back",
	};
}

async function showTools(state: McpExtensionState, ui: McpUi, name: string): Promise<void> {
	for (;;) {
		const selected = await ui.menu(
			() => ({
				title: `${name} — tools`,
				heading: "Tools",
				details: "Open a tool to inspect its description and input schema. Hidden tools cannot be called.",
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
				title: `${tool.name} — tool`,
				heading: "Details",
				facts: formatMcpTool(tool, true)
					.split("\n")
					.map((value) => ({ label: "", value })),
				items: [],
				empty: "",
				confirmLabel: "",
				cancelLabel: "back",
			}));
	}
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

/** The one confirmation shape (`Cancel` first, then the action with what stays unchanged), drawn as a menu. */
async function confirmSignOut(ui: McpUi, name: string): Promise<boolean> {
	const choice = await ui.menu(() => ({
		title: `Sign out of ${name}?`,
		heading: "Confirm",
		items: [
			{ value: "cancel", label: "Cancel" },
			{
				value: "signout",
				label: "Sign out",
				description: "deletes the stored credentials; the server stays configured",
			},
		],
		selected: "cancel",
		confirmLabel: "confirm",
		cancelLabel: "back",
	}));
	return choice === "signout";
}

/** Keep the subscribed menu usable while a connection opens or closes. */
function runInBackground(
	state: McpExtensionState,
	ctx: McpContext,
	server: McpServer,
	operation: () => Promise<string | undefined>,
): void {
	const ready = operation();
	const attempt = server.attempt;
	const { signal } = state.session;
	const finish = (message: string | undefined) => {
		if (signal.aborted || server.attempt !== attempt || !state.servers.includes(server)) return;
		server.message = message;
		state.emitChange();
	};
	void state.track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
}

async function runAction(
	state: McpExtensionState,
	ui: McpUi,
	ctx: McpContext,
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
			if (!(await confirmSignOut(ui, server.entry.name))) break;
			await signOut(state, server);
			break;
		case "tools":
			await showTools(state, ui, server.entry.name);
			break;
	}
	// The session ended meanwhile (for example during a sign-in), which made ctx stale.
	if (signal.aborted) return;
	server.message = message;
	state.emitChange();
}

export async function manage(state: McpExtensionState, ui: McpUi, ctx: McpContext): Promise<void> {
	for (;;) {
		const name = await ui.menu(() => serversMenu(state), state.subscribe);
		if (!name) return;
		if (name === "@add") {
			await addMcpWithUi(state, ui, { docsPath: hostPaths().mcpDocsPath?.() });
			continue;
		}
		for (;;) {
			const action = await ui.menu(() => serverMenu(state, name), state.subscribe);
			const server = state.findServer(name);
			if (!action) break;
			if (server) await runAction(state, ui, ctx, server, action);
			else break;
		}
	}
}
