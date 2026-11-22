import { type Static, Type } from "typebox";
import type { McpContext, McpToolDefinition } from "./host/types.ts";
import { MCP_MANAGE_TOOL_NAME, MCPS_SECTION, mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { mcpGroupLabel, type McpServerGroup } from "./group.ts";
import { formatMcpTool, type McpToolListing } from "./inspection.ts";

const INTENTS = ["list", "tools", "resources", "read", "restart", "stop"] as const;
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

/** The `server` the `mcp` tool's `tools` intent reads a deferred native tool through; a configured server of this name wins. */
export const NATIVE_SERVER = "native";

/**
 * The host's deferred native tools, passed in by the host that owns them. The `mcp` tool reads their full declaration
 * the way it reads an MCP tool's, so the model learns a thin native tool's schema without a refused call.
 */
export interface McpNativeTools {
	/** The names of the native tools this session declares thin (deferred), sorted. */
	deferred(): string[];
	/** One of them in full: the description and input JSON schema it declares when direct. Undefined for any other name. */
	schema(name: string): { description: string; parameters: unknown } | undefined;
	/** A native tool the session already declares in full: its declaration. Undefined for a deferred or unknown name. */
	declared?(name: string): { description: string; parameters: unknown } | undefined;
	/** The model read the tool's full schema: the host declares it in full where its transport can add it in place. */
	loaded?(name: string): void;
}

/** A session's MCP server as the `mcp` tool reports it. */
export interface ManagedMcpServer {
	name: string;
	/** Connection state, with the tool count when connected, for example "connected · 12 tools". */
	state: string;
	connected: boolean;
	error?: string;
	/** Where it comes from, as skills are grouped: core (built in), workspace (project file) or global. */
	group?: McpServerGroup;
	/** The configured one-line purpose (`description` in its configuration). */
	description?: string;
	/** Where it is defined: `built in`, the configuration file, or `plugin <path>`. */
	source?: string;
}

/** What the `mcp` tool does to servers; the MCP feature owns the servers and supplies these. */
export interface McpManageOperations {
	servers(): ManagedMcpServer[];
	/** Read the current catalog without connecting or executing a server. */
	tools?(name: string): McpToolListing[];
	/** A tool's full description and schema were read (`tools` with `tool`); `server` is `native` for a native tool. */
	loaded?(server: string, tool: string): void;
	/** Deferred native tools, read through `server: "native"`. Without it that name is an unknown server. */
	nativeTools?: McpNativeTools;
	/** The server's own instructions from its current connection, shown before its catalog. */
	instructions?(name: string): string | undefined;
	/** Whether the system prompt already holds those instructions, so the catalog points there instead of repeating them. */
	instructionsInPrompt?(name: string): boolean;
	/** Start a stopped or failed server, or restart a running one. Resolves with an error message on failure. */
	restart(name: string, ctx: McpContext): Promise<string | undefined>;
	/** Stop a server for this session. Resolves with an error message when it cannot be stopped. */
	stop(name: string): Promise<string | undefined>;
	/** The server's resources and templates, one per line. */
	resources?(name: string, signal?: AbortSignal): Promise<string>;
	/** One resource's contents as the tool's result content. */
	read?(name: string, uri: string, signal?: AbortSignal): Promise<ResourceReply>;
}

/** A resource's contents as tool result content (text capped and saved like a tool's). */
interface ResourceReply {
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	isError?: boolean;
}

/** A restart this soon after the previous one of the same running server is refused, so a confused loop cannot thrash it. */
const MCP_RESTART_COOLDOWN_MS = 10_000;

const ManageSchema = Type.Object({
	intent: Type.Unsafe<Intent>({ type: "string", enum: [...INTENTS] }),
	server: Type.Optional(
		Type.String({
			description: `Server name; required for every intent except list. "${NATIVE_SERVER}" with tools reads a deferred native tool`,
		}),
	),
	tool: Type.Optional(Type.String({ description: "tools: name for schema" })),
	uri: Type.Optional(Type.String({ description: "read: resource uri" })),
});

/**
 * One server's line, like a skill's listing entry: name, state, group and purpose, then the last error of one that is
 * not connected. With `withSource` (a single-server list) a second line names where it is defined.
 */
const describe = (server: ManagedMcpServer, withSource = false): string => {
	const head = [server.state, server.group ? mcpGroupLabel(server.group) : undefined].filter(Boolean).join(" · ");
	const purpose = server.description?.replace(/\s+/g, " ").trim();
	const error = server.error && !server.connected ? ` — ${server.error.split("\n")[0]}` : "";
	const line = `${server.name}: ${head}${error}${purpose ? `. ${purpose}` : ""}`;
	return withSource && server.source ? `${line}\nDefined in: ${server.source}` : line;
};

/** `tools` for `server: "native"`: one deferred native tool in full (counted as a load), or the list of them. */
function readNative(
	native: McpNativeTools,
	name: string | undefined,
	operations: McpManageOperations,
): { text: string; details: Record<string, unknown> } {
	const deferred = native.deferred();
	if (name === undefined) {
		const lines = deferred.flatMap((each) => {
			const schema = native.schema(each);
			return schema ? [`${each} [deferred] — ${schema.description.split("\n", 1)[0]}`] : [];
		});
		return {
			text:
				lines.length > 0
					? `Deferred native tools (name one in tool for its full schema):\n${lines.join("\n")}`
					: "No native tool is deferred in this session.",
			details: { server: NATIVE_SERVER, tools: deferred.map((each) => ({ name: each, exposure: "deferred" })) },
		};
	}
	const schema = native.schema(name);
	// Already declared in full: reading its schema again is a plain read, not a load.
	const declared = schema ? undefined : native.declared?.(name);
	if (declared) {
		const tool = {
			name,
			description: declared.description,
			inputSchema: declared.parameters as McpToolListing["inputSchema"],
			exposure: "direct" as const,
		};
		return { text: formatMcpTool(tool, true), details: { server: NATIVE_SERVER, tool } };
	}
	if (!schema)
		throw new Error(
			`No native tool named "${name}" in this session. ${
				deferred.length > 0 ? `Deferred now: ${deferred.join(", ")}.` : "No native tool is deferred in this session."
			}`,
		);
	operations.loaded?.(NATIVE_SERVER, name);
	const tool = {
		name,
		description: schema.description,
		inputSchema: schema.parameters as McpToolListing["inputSchema"],
		exposure: "deferred" as const,
	};
	return { text: formatMcpTool(tool, true), details: { server: NATIVE_SERVER, tool } };
}

/**
 * The model's `mcp` tool. It acts on this session's servers only, and changes no configuration file: a subagent
 * restarts its own servers, never its parent's. Adding and removing servers belongs to `/mcp` and `octocode mcp`.
 */
export function createMcpManageTool(operations: McpManageOperations): McpToolDefinition<typeof ManageSchema> {
	const lastRestart = new Map<string, number>();
	/** Servers whose instructions a one-tool read already carried, because the prompt does not hold them. */
	const instructed = new Set<string>();
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
	/** The native tools when `name` asks for them: no configured server has that name, and the host passed the port. */
	const nativeOf = (name: string | undefined): McpNativeTools | undefined =>
		name === NATIVE_SERVER && !operations.servers().some((server) => server.name === name)
			? operations.nativeTools
			: undefined;
	return {
		name: MCP_MANAGE_TOOL_NAME,
		label: "MCP",
		promptSnippet: "When an MCP server fails; to check it or load deferred native tools",
		description: `Manage session MCP servers without changing config. list shows state, tools, group, purpose and errors; name a server for its source. tools lists tools or shows one schema. resources lists resources and URI templates. read takes a URI. restart reconnects (cooldown ${MCP_RESTART_COOLDOWN_MS / 1000}s); stop disconnects. On failure restart, report it and continue with other tools.`,
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
					if (params.server) return reply(describe(find(params.server), true));
					const servers = operations.servers();
					return reply(
						servers.length ? servers.map((server) => describe(server)).join("\n") : "No MCP servers in this session.",
						{
							servers,
						},
					);
				}
				case "tools": {
					const native = nativeOf(params.server);
					if (native) {
						const read = readNative(native, params.tool, operations);
						return reply(read.text, read.details);
					}
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
						operations.loaded?.(server.name, tool.name);
						// A server that keeps its instructions out of the prompt (`instructionsOnDemand`) sends them with its first read.
						const instructions = operations.instructionsInPrompt?.(server.name)
							? undefined
							: operations.instructions?.(server.name);
						const first = instructions !== undefined && !instructed.has(server.name);
						if (first) instructed.add(server.name);
						const schema = formatMcpTool(tool, true);
						return reply(first ? `Instructions:\n${instructions}\n\nTool:\n${schema}` : schema, {
							server: server.name,
							tool,
						});
					}
					const instructions = server.connected ? operations.instructions?.(server.name) : undefined;
					const catalog = tools.length
						? tools.map((tool) => formatMcpTool(tool)).join("\n")
						: server.connected
							? "No tools available in the current connection."
							: `MCP server "${server.name}" is not connected (${server.state}); restart it with intent restart and server "${server.name}", then list its tools again.`;
					const head = !instructions
						? undefined
						: operations.instructionsInPrompt?.(server.name)
							? `Instructions: in the system prompt's <${MCPS_SECTION}> section, block "${server.name}".`
							: `Instructions:\n${instructions}`;
					return reply(head ? `${head}\n\nTools:\n${catalog}` : catalog, {
						server: server.name,
						tools: tools.map(({ name, exposure }) => ({ name, exposure })),
					});
				}
				case "resources": {
					const server = find(params.server);
					if (!operations.resources) throw new Error("Resources are not available in this session.");
					return reply(await operations.resources(server.name, signal), { server: server.name });
				}
				case "read": {
					const server = find(params.server);
					if (!params.uri) throw new Error("Name the resource in the uri field; list them with intent resources.");
					if (!operations.read) throw new Error("Resources are not available in this session.");
					const read = await operations.read(server.name, params.uri, signal);
					return {
						content: read.content,
						details: { intent: params.intent, server: server.name, uri: params.uri },
						...(read.isError ? { isError: true } : {}),
					};
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
