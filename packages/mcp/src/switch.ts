/**
 * Turning one MCP server on or off: `/mcp enable|disable` and the host's switchboard (Octocode's `/harness`) share this,
 * so both persist the same way and report the same text. The host reaches it through the session event bus, like the
 * hook caller, because the MCP owner keeps its server state private.
 */

import type { EventBus } from "@octocodeai/octocode-agent-core";
import { setEnabled } from "./connections.ts";
import { saveConfig } from "./persistence.ts";
import { exposureOf } from "./exposure.ts";
import { describeState, isEnabled } from "./server.ts";
import type { McpFeatureState } from "./state.ts";

export interface McpSwitchRequest {
	name: string;
	enabled: boolean;
	/** Write a project override instead of the server's own file. */
	inProject: boolean;
	/** Only save the switch: the host reloads next, and the new session opens or skips the server from the file. */
	saveOnly?: boolean;
}
export interface McpSwitchResult {
	ok: boolean;
	message: string;
}
export type McpSwitch = (request: McpSwitchRequest) => Promise<McpSwitchResult>;

const REQUEST_SWITCH = "mcp:switch:request";

/** Persist the switch and open or close the connection now; no reload is needed. */
export async function switchMcpServer(state: McpFeatureState, request: McpSwitchRequest): Promise<McpSwitchResult> {
	const server = state.findServer(request.name);
	if (!server) return { ok: false, message: `No MCP server named "${request.name}".` };
	const failure = request.saveOnly
		? saveConfig(state, server, { enabled: request.enabled }, request.inProject)
		: await state.track(setEnabled(state, server, request.enabled, request.inProject));
	if (failure) return { ok: false, message: failure };
	// Where the change was written: the override file, the definition file, or nowhere for a session-only server.
	const saved = server.entry.scope === "feature" ? "this session" : (server.entry.override ?? server.entry.source);
	return {
		ok: true,
		message: `${request.name}: ${isEnabled(server) ? "enabled" : "disabled"} · ${describeState(server, false)} · ${exposureOf(server.entry)}. Saved to ${saved}.`,
	};
}

/** Answer switch requests for the running session with `handle`; returns the unregister function. */
export function registerMcpSwitch(events: EventBus, handle: McpSwitch): () => void {
	return events.on(REQUEST_SWITCH, (reply) => {
		if (typeof reply === "function") reply(handle);
	});
}

/** What a reload changed: servers that connect (or wait, when disabled or unselected) and servers that closed. */
export interface McpReloadResult {
	/** Server names now configured that were not, or whose definition changed (they restart, so both lists name them). */
	added: string[];
	removed: string[];
}
export type McpReload = () => Promise<McpReloadResult>;

const REQUEST_RELOAD = "mcp:reload:request";

/** Answer reload requests for the running session with `handle`; returns the unregister function. */
export function registerMcpReload(events: EventBus, handle: McpReload): () => void {
	return events.on(REQUEST_RELOAD, (reply) => {
		if (typeof reply === "function") reply(handle);
	});
}

/**
 * Re-read the MCP config files with the current settings (a vendor switched by `/harness`, say) and connect or close
 * the difference now. Resolves undefined when no MCP owner runs (MCP disabled), like `getMcpSwitch`.
 */
export async function requestMcpReload(events: EventBus): Promise<McpReloadResult | undefined> {
	let handle: McpReload | undefined;
	events.emit(REQUEST_RELOAD, (value: McpReload) => {
		handle = value;
	});
	return handle?.();
}

/** The session's MCP switch, or undefined when no MCP owner runs (MCP disabled). */
export function getMcpSwitch(events: EventBus): McpSwitch | undefined {
	let handle: McpSwitch | undefined;
	events.emit(REQUEST_SWITCH, (value: McpSwitch) => {
		handle = value;
	});
	return handle;
}
