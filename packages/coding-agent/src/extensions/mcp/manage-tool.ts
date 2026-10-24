import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { MCP_MANAGE_TOOL_NAME, type McpServerConfig, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { formatMcpTool, type McpToolListing } from "./inspection.ts";

const INTENTS = ["list", "status", "tools", "connect", "restart", "stop", "add", "remove"] as const;
type Intent = (typeof INTENTS)[number];

/** A session's MCP server as the `mcp` tool reports it. */
export interface ManagedMcpServer {
	name: string;
	/** Connection state, with the tool count when connected, for example "connected · 12 tools". */
	state: string;
	connected: boolean;
	/** Where it comes from: a config file, this session (`added`), or a server another part of Octocode runs (`automatic`). */
	origin: "configured" | "added" | "automatic";
	error?: string;
}

/** What the `mcp` tool does to servers; the MCP extension owns the servers and supplies these. */
export interface McpManageOperations {
	servers(): ManagedMcpServer[];
	/** Read the current catalog without connecting or executing a server. */
	tools?(name: string): McpToolListing[];
	/** Start a stopped or failed server, or restart a running one. Resolves with an error message on failure. */
	restart(name: string, ctx: ExtensionContext): Promise<string | undefined>;
	/** Stop a server for this session. Resolves with an error message when it cannot be stopped. */
	stop(name: string): Promise<string | undefined>;
	/** Run a new server for this session only. */
	add(name: string, config: McpServerConfig): void;
	/** Remove a server this tool added. Returns an error message when it was not added here. */
	remove(name: string): Promise<string | undefined>;
}

/** A restart this soon after the previous one of the same server is refused, so a confused loop cannot thrash it. */
const MCP_RESTART_COOLDOWN_MS = 10_000;

const ConfigSchema = Type.Object(
	{
		command: Type.Optional(Type.String({ description: "Executable for a stdio server" })),
		args: Type.Optional(Type.Array(Type.String())),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		cwd: Type.Optional(Type.String()),
		url: Type.Optional(Type.String({ description: "HTTP or legacy SSE endpoint" })),
		type: Type.Optional(Type.Unsafe<"http" | "sse" | "stdio">({ type: "string", enum: ["http", "sse", "stdio"] })),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		literalHeaders: Type.Optional(
			Type.Boolean({ description: "Send HTTP/SSE header values literally without environment or command resolution" }),
		),
	},
	{ additionalProperties: false, description: "For add: command (and args, env, cwd) or url (and headers)" },
);

const ManageSchema = Type.Object({
	intent: Type.Unsafe<Intent>({ type: "string", enum: [...INTENTS], description: "What to do" }),
	server: Type.Optional(Type.String({ description: "Server name; every intent but list needs it" })),
	tool: Type.Optional(
		Type.String({ description: "For tools: one tool name to inspect its full description and schema" }),
	),
	config: Type.Optional(ConfigSchema),
});

/** What the user confirms: where the server runs or connects, and the names (never the values) of the env and headers it is given. */
function describeNewServer(config: McpServerConfig): string {
	const target = "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
	const names = (label: string, record: Record<string, string> | undefined) =>
		record && Object.keys(record).length > 0 ? `\n${label}: ${Object.keys(record).join(", ")}` : "";
	const cwd = "cwd" in config && config.cwd ? `\nWorking directory: ${config.cwd}` : "";
	return `${target}${cwd}${"url" in config ? names("Headers", config.headers) : names("Environment variables", config.env)}`;
}

const describe = (server: ManagedMcpServer): string =>
	`${server.name}: ${server.state}${server.origin === "configured" ? "" : ` (${server.origin})`}${
		server.error && !server.connected ? ` — ${server.error.split("\n")[0]}` : ""
	}`;

/**
 * The model's `mcp` tool. It acts on this session's servers only, and changes no configuration file: a subagent
 * restarts its own servers, never its parent's. Adding a server runs a new command, so it needs the user's confirmation.
 */
export function createMcpManageTool(operations: McpManageOperations): ToolDefinition<typeof ManageSchema> {
	const lastRestart = new Map<string, number>();
	const find = (name: string | undefined): ManagedMcpServer => {
		const servers = operations.servers();
		const server = name ? servers.find((candidate) => candidate.name === name) : undefined;
		if (server) return server;
		const known = servers.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(
			name ? `No MCP server "${name}" in this session. Servers: ${known}.` : `Name the server. Servers: ${known}.`,
		);
	};
	return {
		name: MCP_MANAGE_TOOL_NAME,
		label: "MCP",
		description:
			"Manage this session's MCP servers. list or status: state, tool count and last error. tools: inspect the current catalog; name a tool for its full description and input schema, without running it. connect or restart: start a server whose tools fail, time out or lost their connection. stop: end a server for this session. add: run a new server for this session (the user confirms). remove: drop a server this tool added. Configuration files are not changed.",
		promptSnippet: "Check, restart, stop or add this session's MCP servers",
		parameters: ManageSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const reply = (text: string, details: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text }],
				details: { intent: params.intent, ...details },
			});
			switch (params.intent) {
				case "list": {
					const servers = operations.servers();
					return reply(servers.length ? servers.map(describe).join("\n") : "No MCP servers in this session.", {
						servers,
					});
				}
				case "status":
					return reply(describe(find(params.server)));
				case "tools": {
					const server = find(params.server);
					const tools = server.connected ? (operations.tools?.(server.name) ?? []) : [];
					if (params.tool) {
						const tool = tools.find((candidate) => candidate.name === params.tool);
						if (!tool) throw new Error(`No available tool named "${params.tool}" on MCP server "${server.name}".`);
						return reply(formatMcpTool(tool, true), { server: server.name, tool });
					}
					return reply(
						tools.length
							? tools.map((tool) => formatMcpTool(tool)).join("\n")
							: "No tools available in the current connection.",
						{
							server: server.name,
							tools: tools.map(({ name, exposure }) => ({ name, exposure })),
						},
					);
				}
				case "connect":
				case "restart": {
					const server = find(params.server);
					if (params.intent === "connect" && server.connected) return reply(`${describe(server)}; already connected.`);
					const last = lastRestart.get(server.name);
					if (last !== undefined && Date.now() - last < MCP_RESTART_COOLDOWN_MS)
						throw new Error(
							`MCP server "${server.name}" was restarted ${Math.round((Date.now() - last) / 1000)}s ago; check its status before restarting again.`,
						);
					lastRestart.set(server.name, Date.now());
					signal?.throwIfAborted();
					const failure = await operations.restart(server.name, ctx);
					if (failure) throw new Error(`Restarting MCP server "${server.name}" failed: ${failure}`);
					return reply(`Restarted. ${describe(find(server.name))}`);
				}
				case "stop": {
					const server = find(params.server);
					const failure = await operations.stop(server.name);
					if (failure) throw new Error(failure);
					return reply(`Stopped for this session. ${describe(find(server.name))}`);
				}
				case "add": {
					const name = params.server?.trim();
					if (!name || !params.config) throw new Error("add needs server and config (command or url).");
					if (operations.servers().some((server) => server.name === name))
						throw new Error(`MCP server "${name}" already exists; restart it instead.`);
					const config = validateMcpServerConfig(name, params.config);
					if (typeof config === "string") throw new Error(config);
					// A new server runs a new command or reaches a new endpoint: the user decides, never the model alone.
					if (!ctx.hasUI)
						throw new Error(
							"Adding an MCP server needs the user's confirmation, and this session cannot ask. Ask the user to add it with /mcp or `octocode mcp add`.",
						);
					const confirmed = await ctx.ui.confirm(
						"Add MCP server?",
						`The agent wants to add "${name}" for this session: ${describeNewServer(config)}`,
						{ signal },
					);
					signal?.throwIfAborted();
					if (!confirmed) throw new Error(`The user declined adding MCP server "${name}".`);
					operations.add(name, config);
					return reply(`Added MCP server "${name}" for this session; its tools appear once it connects.`);
				}
				case "remove": {
					const server = find(params.server);
					const failure = await operations.remove(server.name);
					if (failure) throw new Error(failure);
					return reply(`Removed MCP server "${server.name}" from this session.`);
				}
				default:
					throw new Error(`Unknown intent "${String(params.intent)}". Use one of: ${INTENTS.join(", ")}.`);
			}
		},
	};
}
