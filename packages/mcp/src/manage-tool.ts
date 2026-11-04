import { type Static, Type } from "typebox";
import type { McpContext, McpToolDefinition } from "./host/types.ts";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import { MCP_MANAGE_TOOL_NAME } from "./servers.ts";
import { formatMcpTool, type McpToolListing } from "./inspection.ts";

const INTENTS = ["list", "tools", "restart", "stop"] as const;
type Intent = (typeof INTENTS)[number];

/** Intents earlier versions accepted; a call or replayed session that still names one learns what replaces it. */
const REMOVED_INTENTS: Record<string, string> = {
	status: "use list (add server for one server)",
	connect: "use restart, which also starts a stopped or failed server",
	add: "ask the user to add a server with /mcp or `octocode mcp add`",
	remove: "ask the user to remove a server with /mcp or `octocode mcp remove`",
};

function assertCurrentIntent(intent: unknown): void {
	const replacement = typeof intent === "string" ? REMOVED_INTENTS[intent] : undefined;
	if (replacement) throw new Error(`The mcp intent "${intent as string}" was removed: ${replacement}.`);
}

/** A session's MCP server as the `mcp` tool reports it. */
export interface ManagedMcpServer {
	name: string;
	/** Connection state, with the tool count when connected, for example "connected · 12 tools". */
	state: string;
	connected: boolean;
	error?: string;
}

/** What the `mcp` tool does to servers; the MCP extension owns the servers and supplies these. */
export interface McpManageOperations {
	servers(): ManagedMcpServer[];
	/** Read the current catalog without connecting or executing a server. */
	tools?(name: string): McpToolListing[];
	/** The server's own instructions from its current connection, shown before its catalog. */
	instructions?(name: string): string | undefined;
	/** Start a stopped or failed server, or restart a running one. Resolves with an error message on failure. */
	restart(name: string, ctx: McpContext): Promise<string | undefined>;
	/** Stop a server for this session. Resolves with an error message when it cannot be stopped. */
	stop(name: string): Promise<string | undefined>;
}

/** A restart this soon after the previous one of the same running server is refused, so a confused loop cannot thrash it. */
const MCP_RESTART_COOLDOWN_MS = 10_000;

const ManageSchema = Type.Object({
	intent: Type.Unsafe<Intent>({ type: "string", enum: [...INTENTS] }),
	server: Type.Optional(Type.String({ description: "Server name; required for every intent except list" })),
	tool: Type.Optional(Type.String({ description: "tools: the tool to inspect" })),
});

const describe = (server: ManagedMcpServer): string =>
	`${server.name}: ${server.state}${server.error && !server.connected ? ` — ${server.error.split("\n")[0]}` : ""}`;

/**
 * The model's `mcp` tool. It acts on this session's servers only, and changes no configuration file: a subagent
 * restarts its own servers, never its parent's. Adding and removing servers belongs to `/mcp` and `octocode mcp`.
 */
export function createMcpManageTool(operations: McpManageOperations): McpToolDefinition<typeof ManageSchema> {
	const lastRestart = new Map<string, number>();
	const find = (name: string | undefined): ManagedMcpServer => {
		const servers = operations.servers();
		const server = name ? servers.find((candidate) => candidate.name === name) : undefined;
		if (server) return server;
		const known = servers.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(
			name
				? `No MCP server "${name}" in this session. Servers: ${known}.`
				: `Name the server in the server field (every intent except list needs it). Servers: ${known}.`,
		);
	};
	return {
		name: MCP_MANAGE_TOOL_NAME,
		label: "MCP",
		promptSnippet: "When an MCP server's tools fail, time out or disappear, or to check its state",
		description:
			"Manage this session's MCP servers; configuration files are not changed. list: state, tool count and last error of every server, or of one with server. tools: the current catalog; add tool for its full description and schemas, without running it. restart: start a stopped or failed server, or reconnect a running one (a second restart within 10s is refused). stop: end a server for this session, default servers included.",
		parameters: ManageSchema,
		// A removed intent fails the schema's enum with a bare list; this names its replacement instead.
		prepareArguments(args) {
			assertCurrentIntent((args as { intent?: unknown } | null)?.intent);
			return args as Static<typeof ManageSchema>;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			assertCurrentIntent(params.intent);
			const reply = (text: string, details: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text }],
				details: { intent: params.intent, ...details },
			});
			switch (params.intent) {
				case "list": {
					if (params.server) return reply(describe(find(params.server)));
					const servers = operations.servers();
					return reply(servers.length ? servers.map(describe).join("\n") : "No MCP servers in this session.", {
						servers,
					});
				}
				case "tools": {
					const server = find(params.server);
					const tools = server.connected ? (operations.tools?.(server.name) ?? []) : [];
					if (params.tool) {
						// The server's tool name, or the name the model calls it by, whole or after the block's `tools` prefix.
						const tool =
							tools.find((candidate) => candidate.name === params.tool) ??
							tools.find(
								(candidate) =>
									candidate.callName === params.tool ||
									candidate.callName === `${mcpNamespace(server.name)}__${params.tool}`,
							);
						if (!tool) throw new Error(`No available tool named "${params.tool}" on MCP server "${server.name}".`);
						return reply(formatMcpTool(tool, true), { server: server.name, tool });
					}
					const instructions = server.connected ? operations.instructions?.(server.name) : undefined;
					const catalog = tools.length
						? tools.map((tool) => formatMcpTool(tool)).join("\n")
						: "No tools available in the current connection.";
					return reply(instructions ? `Instructions:\n${instructions}\n\nTools:\n${catalog}` : catalog, {
						server: server.name,
						tools: tools.map(({ name, exposure }) => ({ name, exposure })),
					});
				}
				case "restart": {
					const server = find(params.server);
					const last = lastRestart.get(server.name);
					// A stopped or failed server starts at once; the guard only stops a loop from thrashing a live one.
					if (server.connected && last !== undefined && Date.now() - last < MCP_RESTART_COOLDOWN_MS)
						throw new Error(
							`MCP server "${server.name}" was restarted ${Math.round((Date.now() - last) / 1000)}s ago; list it to check its state before restarting again.`,
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
				default:
					throw new Error(`Unknown intent "${String(params.intent)}". Use one of: ${INTENTS.join(", ")}.`);
			}
		},
	};
}
