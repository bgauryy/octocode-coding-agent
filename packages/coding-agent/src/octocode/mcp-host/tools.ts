/**
 * The MCP workspace's tool switch port: what the `/mcp` server → tools page shows of each tool (the exposure a new
 * session declares, who gets the server) and the writes behind its choices. The tool list comes from the running
 * session's registry (reading connects nothing); pins and `defaultActive` come from the files a new session reads, so a
 * change shows at once while the live state keeps what this session declared. Writes go through the `mcp-pins`
 * adapter, the same files the web Tools panel writes.
 */

import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
import {
	currentMcpToolStates,
	type McpHostPorts,
	type McpServerToolStates,
	type McpToolSwitchRow,
	type McpToolSwitchView,
	type McpToolWriteScope,
} from "../../../../mcp/src/api.ts";
import { loadMcpServers, switchTarget } from "../../configuration/adapters/mcp.ts";
import {
	NEXT_SESSION,
	pinMcpTool,
	setMcpDefaultActive,
	setMcpExposure,
} from "../../configuration/adapters/mcp-pins.ts";
import type { ConfigContext } from "../../configuration/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

/** The reads and writes of one session place's tools page. */
export interface McpToolsSource {
	view(server: string, scope: McpToolWriteScope): McpToolSwitchView;
	/** Pins `tool` (`null` removes the pin); answers with a line for the user. */
	pin(server: string, scope: McpToolWriteScope, tool: string, pin: McpExposure | null): string;
	/** Writes `defaultActive`; answers with a line for the user. */
	assign(server: string, scope: McpToolWriteScope, everyAgent: boolean): string;
	/** Writes the server's `exposure`; answers with a line for the user. */
	setExposure(server: string, scope: McpToolWriteScope, exposure: McpExposure): string;
}

export interface McpToolsSourceOptions {
	ctx: () => ConfigContext;
	/** The session's tool states; default: the MCP registry's. */
	live?: () => McpServerToolStates[] | undefined;
}

export function createMcpToolsSource(options: McpToolsSourceOptions): McpToolsSource {
	const live = options.live ?? currentMcpToolStates;
	return {
		view(server, scope) {
			const ctx = options.ctx();
			const loaded = loadMcpServers(ctx);
			const entry = loaded.servers.find((candidate) => candidate.name === server);
			const session = live()?.find((candidate) => candidate.server === server);
			const defaultState = entry?.config.exposure ?? "direct";
			const pins = entry?.config.toolExposure ?? {};
			const tools = new Map<string, McpToolSwitchRow>();
			for (const tool of session?.connected ? session.tools : []) {
				const pin = pins[tool.name];
				// A pin the session declared by that has since been removed: the tool falls back to the server's setting.
				const state = pin ?? (tool.decidedBy === "pin" ? defaultState : tool.state);
				tools.set(tool.name, {
					name: tool.name,
					...(pin ? { pin } : {}),
					state,
					live: tool.state,
					...(tool.audit ? { audit: tool.audit } : {}),
				});
			}
			for (const [name, pin] of Object.entries(pins))
				if (!name.includes("*") && !tools.has(name)) tools.set(name, { name, pin, state: pin });
			const blocked = !entry
				? "This server is not in a configuration file, so its tools cannot be switched here."
				: scope === "project" && !ctx.projectTrusted
					? "This project is not trusted, so project scope cannot be written. Trust it with /trust."
					: undefined;
			return {
				name: server,
				connected: session?.connected === true,
				tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
				everyAgent: entry?.config.defaultActive !== false,
				defaultState,
				...(blocked ? { blocked } : {}),
				...(entry && !blocked ? { target: homeTilde(switchTarget(entry, loaded, scope, ctx), ctx.home) } : {}),
			};
		},
		pin(server, scope, tool, pin) {
			const target = pinMcpTool(options.ctx(), scope, server, tool, pin);
			return `${pin === null ? `Removed the pin of ${tool}.` : `Pinned ${tool} ${pin}.`} Saved to ${homeTilde(target, options.ctx().home)}. ${NEXT_SESSION}`;
		},
		setExposure(server, scope, exposure) {
			const target = setMcpExposure(options.ctx(), scope, server, exposure);
			return `Tools of ${server} default to ${exposure}. Saved to ${homeTilde(target, options.ctx().home)}. ${NEXT_SESSION}`;
		},
		assign(server, scope, everyAgent) {
			const target = setMcpDefaultActive(options.ctx(), scope, server, everyAgent);
			return `${
				everyAgent
					? `${server} is in every agent's default tool selection.`
					: `Only agents whose profile tools: name mcp__${server}__ get ${server}.`
			} Saved to ${homeTilde(target, options.ctx().home)}. ${NEXT_SESSION}`;
		},
	};
}

/** The port for the MCP workspace: one source per call, for the place the page runs in. */
export function createMcpToolSwitch(
	options: { live?: () => McpServerToolStates[] | undefined; home?: string } = {},
): McpHostPorts["toolSwitch"] {
	const source = (place: { cwd: string; agentDir: string; projectTrusted: boolean }) => {
		const ctx: ConfigContext = {
			...place,
			settings: SettingsManager.create(place.cwd, place.agentDir, { projectTrusted: place.projectTrusted }),
			...(options.home ? { home: options.home } : {}),
		};
		return createMcpToolsSource({ ctx: () => ctx, ...(options.live ? { live: options.live } : {}) });
	};
	return {
		view: (place, server, scope) => source(place).view(server, scope),
		pin: (place, server, scope, tool, pin) => source(place).pin(server, scope, tool, pin),
		assign: (place, server, scope, everyAgent) => source(place).assign(server, scope, everyAgent),
		setExposure: (place, server, scope, exposure) => source(place).setExposure(server, scope, exposure),
	};
}
