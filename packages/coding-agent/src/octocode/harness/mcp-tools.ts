/**
 * What `/harness` shows when a MCP server is opened: each tool with the exposure a new session declares, and who gets
 * the server. The tool list comes from the running session's registry (reading connects nothing); pins and
 * `defaultActive` come from the files a new session reads, so a change shows at once while the live state keeps what
 * this session declared.
 */

import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
import { currentMcpToolStates, type McpServerToolStates } from "../../../../mcp/src/api.ts";
import { homeTilde } from "../../../../common/src/home-tilde.ts";
import { loadMcpServers, switchTarget } from "../../configuration/adapters/mcp.ts";
import type { ConfigContext } from "../../configuration/types.ts";
import {
	NEXT_SESSION,
	type McpWriteScope,
	pinMcpTool,
	setMcpDefaultActive,
	setMcpExposure,
} from "../../configuration/adapters/mcp-pins.ts";

export interface McpToolRow {
	name: string;
	/** The server's `toolExposure` entry for this exact name. */
	pin?: McpExposure;
	/** What a new session declares: the pin, else what the session reports, else the server's default. */
	state: McpExposure;
	/** What the running session declares; absent when it does not list the tool. */
	live?: McpExposure;
}

export interface McpServerView {
	name: string;
	/** The session lists this server's tools (it is connected). */
	connected: boolean;
	/** The tool rows: every tool the session lists, then pinned tools it does not. */
	tools: McpToolRow[];
	/** `defaultActive`: in every agent's default tool selection, or only in agents whose `tools:` name it. */
	everyAgent: boolean;
	/** The exposure a tool without a pin gets from the server's own setting. */
	defaultState: McpExposure;
	/** Why a change cannot be saved here; absent when it can. */
	blocked?: string;
	/** The file a change is written to, home shortened. */
	target?: string;
}

/** The reads and writes of the server view, so the picker needs neither the MCP owner nor the files. */
export interface McpToolsSource {
	view(server: string, scope: McpWriteScope): McpServerView;
	/** Pins `tool` (`null` removes the pin); answers with a line for the user. */
	pin(server: string, scope: McpWriteScope, tool: string, pin: McpExposure | null): string;
	/** Writes `defaultActive`; answers with a line for the user. */
	assign(server: string, scope: McpWriteScope, everyAgent: boolean): string;
	/** Writes the server's `exposure`; answers with a line for the user. */
	setExposure(server: string, scope: McpWriteScope, exposure: McpExposure): string;
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
			const tools = new Map<string, McpToolRow>();
			for (const tool of session?.connected ? session.tools : []) {
				const pin = pins[tool.name];
				// A pin the session declared by that has since been removed: the tool falls back to the server's setting.
				const state = pin ?? (tool.decidedBy === "pin" ? defaultState : tool.state);
				tools.set(tool.name, { name: tool.name, ...(pin ? { pin } : {}), state, live: tool.state });
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
