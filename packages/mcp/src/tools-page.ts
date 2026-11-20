/**
 * The `/mcp` server → tools page: each tool with the exposure a new session declares, who gets the server, and the
 * server's default. Opening a tool shows its schema and, when the host installed the tool switch port, the exposure
 * choices; the two server rows open their own choices. Writes go through the port (`hostToolSwitch`), which owns the
 * files; without it the page only inspects. `/harness` opens this page through the session event bus.
 */

import type { EventBus } from "@octocodeai/octocode-agent-core";
import { formatAudit } from "@octocodeai/octocode-common/tool-audit";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
import type { McpCommandContext } from "./host/types.ts";
import {
	hostPaths,
	hostToolSwitch,
	type McpToolSwitchPort,
	type McpToolSwitchRow,
	type McpToolSwitchView,
	type McpToolWriteScope,
	type McpVendorPlace,
} from "./host.ts";
import { formatMcpTool, toolCatalog, toolSummary } from "./inspection.ts";
import { MCP_EXPOSURES } from "./servers.ts";
import type { McpFeatureState } from "./state.ts";
import { type McpMenu, type McpMenuItem, type McpUi, showMcpManager } from "./ui.ts";

const AVAILABLE = "@available";
const DEFAULT = "@default";
const UNPIN = "@unpin";

const EXPOSURE_TEXT: Record<McpExposure, string> = {
	direct: "declared in full",
	deferred: "declared with names and types; the schema detail loads through the mcp tool",
	onDemand: "not declared until its first call or a load",
	hidden: "not offered; cannot be called",
};

/** One flash line under the list: a saved change, or why it was not saved. */
interface Flash {
	text: string;
	error: boolean;
}

/** A write through the port for one server: answers with the line for the user. */
type Change = (port: McpToolSwitchPort, place: McpVendorPlace, scope: McpToolWriteScope) => string;

/** The port bound to one server and scope; undefined when the host installed none. */
interface ServerSwitch {
	view(): McpToolSwitchView;
	write(change: Change): Flash;
}

function bindSwitch(state: McpFeatureState, server: string, scope: McpToolWriteScope): ServerSwitch | undefined {
	const port = hostToolSwitch();
	if (!port) return undefined;
	const place = (): McpVendorPlace => ({
		cwd: state.sessionCwd,
		agentDir: hostPaths().agentDir(),
		projectTrusted: state.projectTrusted,
	});
	return {
		view: () => port.view(place(), server, scope),
		write: (change) => {
			const blocked = port.view(place(), server, scope).blocked;
			if (blocked) return { text: blocked, error: true };
			try {
				return { text: change(port, place(), scope), error: false };
			} catch (error) {
				return { text: errorMessage(error), error: true };
			}
		},
	};
}

const tone = (exposure: McpExposure): McpMenuItem["tone"] => (exposure === "direct" ? "success" : "muted");

function toolNote(row: McpToolSwitchRow, description: string | undefined): string {
	return [
		row.pin ? "pinned" : "",
		row.live !== undefined && row.live !== row.state ? "from the next session" : "",
		row.audit ? `${formatAudit(row.audit)}${row.audit.reason ? ` · ${row.audit.reason}` : ""}` : "",
		toolSummary(description),
	]
		.filter(Boolean)
		.join(" · ");
}

function toolsMenu(state: McpFeatureState, name: string, sw: ServerSwitch | undefined, flash?: Flash): McpMenu {
	const catalog = toolCatalog(state, name);
	const flashLines = {
		details: flash && !flash.error ? flash.text : undefined,
		error: flash?.error ? flash.text : undefined,
	};
	if (!sw)
		return {
			title: `${name} — tools`,
			heading: "Tools",
			details: "Open a tool to inspect its description and input schema. Hidden tools cannot be called.",
			items: catalog.map((tool) => ({
				value: tool.name,
				label: tool.name,
				description: toolSummary(tool.description),
				badge: tool.exposure,
				tone: tone(tool.exposure),
			})),
			empty: "No tools available. The server may be disabled, disconnected, or offer no tools.",
			confirmLabel: "inspect",
			cancelLabel: "back",
		};
	const view = sw.view();
	const count = `${view.tools.length} tool${view.tools.length === 1 ? "" : "s"}`;
	return {
		title: `${name} — tools`,
		heading: "Tools",
		facts: [
			{ label: "State", value: view.connected ? `connected · ${count}` : `not connected · ${count} pinned` },
			{ label: "Writes", value: view.target ?? view.blocked ?? "nothing" },
		],
		details: [
			flashLines.details,
			view.connected ? undefined : "Connect the server to list its tools.",
			"Changes apply from the next session.",
		]
			.filter(Boolean)
			.join("\n"),
		error: flashLines.error,
		items: [
			{
				value: AVAILABLE,
				label: "Available to",
				description: "who gets this server",
				badge: view.everyAgent ? "every agent" : "agents that name it",
			},
			{ value: DEFAULT, label: "Default for tools", description: "a tool without a pin", badge: view.defaultState },
			...view.tools.map((row) => ({
				value: row.name,
				label: row.name,
				description: toolNote(row, catalog.find((tool) => tool.name === row.name)?.description),
				badge: row.state,
				tone: tone(row.state),
			})),
		],
		confirmLabel: "open",
		cancelLabel: "back",
	};
}

/** A choice page: one row per outcome, the current one selected. Resolves to the chosen value. */
function choose(
	ui: McpUi,
	title: string,
	facts: McpMenu["facts"],
	items: McpMenuItem[],
	current: string,
): Promise<string | undefined> {
	return ui.menu(() => ({
		title,
		heading: "Choose",
		facts,
		items: items.map((item) => (item.value === current ? { ...item, badge: "current", tone: "success" } : item)),
		selected: current,
		confirmLabel: "select",
		cancelLabel: "back",
	}));
}

const exposureItems = (): McpMenuItem[] =>
	MCP_EXPOSURES.map((exposure) => ({ value: exposure, label: exposure, description: EXPOSURE_TEXT[exposure] }));

/** The tool's schema, and with a switch its exposure choices. Resolves to the flash of a saved choice. */
async function toolPage(
	state: McpFeatureState,
	ui: McpUi,
	name: string,
	tool: string,
	sw: ServerSwitch | undefined,
): Promise<Flash | undefined> {
	const listing = toolCatalog(state, name).find((candidate) => candidate.name === tool);
	const facts = (
		listing ? formatMcpTool(listing, true).split("\n") : ["Connect the server to read this tool's schema."]
	).map((value) => ({ label: "", value }));
	if (!sw) {
		if (listing)
			await ui.menu(() => ({
				title: `${tool} — tool`,
				heading: "Details",
				facts,
				items: [],
				empty: "",
				confirmLabel: "",
				cancelLabel: "back",
			}));
		return undefined;
	}
	const view = sw.view();
	const row = view.tools.find((candidate) => candidate.name === tool);
	if (!row) return undefined;
	const items = [
		...exposureItems(),
		...(row.pin
			? [{ value: UNPIN, label: "server default", description: `remove the pin; follow ${view.defaultState}` }]
			: []),
	];
	const picked = await choose(ui, `${tool} — tool`, facts, items, row.state);
	if (!picked || (picked === row.state && picked === row.pin)) return undefined;
	const pin = picked === UNPIN ? null : (picked as McpExposure);
	return sw.write((port, place, scope) => port.pin(place, name, scope, tool, pin));
}

async function serverChoice(
	ui: McpUi,
	name: string,
	row: string,
	view: McpToolSwitchView,
): Promise<string | undefined> {
	if (row === AVAILABLE)
		return choose(
			ui,
			`${name} — available to`,
			undefined,
			[
				{ value: "every", label: "Every agent", description: "its default tool selection includes this server" },
				{
					value: "named",
					label: "Only agents that name it",
					description: `agents whose profile tools: lists mcp__${name}__`,
				},
			],
			view.everyAgent ? "every" : "named",
		);
	return choose(ui, `${name} — default for tools`, undefined, exposureItems(), view.defaultState);
}

/**
 * The tools page of server `name`. `scope` is where switches are written: the server's own scope unless the caller
 * names one (`/harness` passes its scope switch).
 */
export async function showServerTools(
	state: McpFeatureState,
	ui: McpUi,
	name: string,
	scope?: McpToolWriteScope,
): Promise<void> {
	const sw = bindSwitch(
		state,
		name,
		scope ?? (state.findServer(name)?.entry.scope === "project" ? "project" : "global"),
	);
	let flash: Flash | undefined;
	for (;;) {
		const shown = flash;
		const selected = await ui.menu(() => toolsMenu(state, name, sw, shown), state.subscribe);
		flash = undefined;
		if (!selected) return;
		if (!sw || (selected !== AVAILABLE && selected !== DEFAULT)) {
			flash = await toolPage(state, ui, name, selected, sw);
			continue;
		}
		const view = sw.view();
		const picked = await serverChoice(ui, name, selected, view);
		if (!picked) continue;
		if (selected === AVAILABLE) {
			const every = picked === "every";
			if (every !== view.everyAgent) flash = sw.write((port, place, target) => port.assign(place, name, target, every));
		} else if (picked !== view.defaultState) {
			const exposure = picked as McpExposure;
			flash = sw.write((port, place, target) => port.setExposure(place, name, target, exposure));
		}
	}
}

/** Opens the tools page of one server in the `/mcp` view: `/harness` calls it for an MCP row. */
export type McpToolsPageOpener = (ctx: McpCommandContext, server: string, scope?: McpToolWriteScope) => Promise<void>;

const REQUEST_TOOLS_PAGE = "mcp:tools-page:request";

/** Answer tools-page requests for the running session; returns the unregister function. */
export function registerMcpToolsPage(events: EventBus, state: McpFeatureState): () => void {
	const open: McpToolsPageOpener = (ctx, server, scope) =>
		showMcpManager(ctx, (ui) => showServerTools(state, ui, server, scope));
	return events.on(REQUEST_TOOLS_PAGE, (reply) => {
		if (typeof reply === "function") reply(open);
	});
}

/** The session's tools-page opener, or undefined when no MCP owner runs (MCP disabled). */
export function getMcpToolsPage(events: EventBus): McpToolsPageOpener | undefined {
	let handle: McpToolsPageOpener | undefined;
	events.emit(REQUEST_TOOLS_PAGE, (value: McpToolsPageOpener) => {
		handle = value;
	});
	return handle;
}
