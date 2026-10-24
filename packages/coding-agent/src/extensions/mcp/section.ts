import { mcpNamespace, OCTOCODE_SERVER } from "../../core/mcp-servers.ts";
import type { McpServerEntry } from "./config.ts";
import { hasDirectTools, hasIndirectTools } from "./exposure.ts";

/** Name of the system prompt section that lists the session's MCP servers. */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server summary in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/** Characters of a server's instructions in the section; Codex asks servers to keep their first 512 self-contained. */
const MAX_SERVER_INSTRUCTIONS_CHARS = 512;
/** Tool names listed per server before the rest are counted; tool_search still finds them. */
const MAX_LISTED_TOOLS = 40;
/** Characters of a tool's one-line description next to its name. */
const MAX_TOOL_DESCRIPTION_CHARS = 80;
/**
 * Characters of the whole section. Instructions shrink first, then tool descriptions, then summaries and tool lists;
 * when the server lines alone do not fit, the last servers are left out and counted in a closing line.
 */
export const MAX_SERVERS_SECTION_CHARS = 6144;

/** What the `mcp_servers` section needs of a server. */
export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string };
	/**
	 * The server's registered tools once it connected: the full names (with descriptions) of those `tool_search` loads,
	 * and how many are declared directly. Before it connects, its configured exposures decide how it is listed.
	 */
	tools?: { deferred: readonly McpListedTool[]; direct: number };
}

/** A tool `tool_search` loads: its full name and, when it has one, its description. */
export interface McpListedTool {
	name: string;
	description?: string;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The server's summary (the configured description, else the first line of its instructions) and the rest of its
 * instructions, so neither repeats the other.
 */
function serverText(server: McpServerListing): { summary: string; instructions: string } {
	const description = server.entry.config.description?.trim();
	const instructions = server.connection?.instructions?.trim() ?? "";
	if (description)
		return { summary: oneLine(description.split("\n", 1)[0] ?? ""), instructions: oneLine(instructions) };
	const [first = "", ...rest] = instructions.split("\n");
	return { summary: oneLine(first), instructions: oneLine(rest.join("\n")) };
}

/** How the model reaches the server's tools: `tool_search` when some are loaded on demand, else `declared`. */
function reachOf(server: McpServerListing): "tool_search" | "declared" | undefined {
	if (server.tools) {
		if (server.tools.deferred.length > 0) return "tool_search";
		return server.tools.direct > 0 ? "declared" : undefined;
	}
	if (hasIndirectTools(server.entry)) return "tool_search";
	return hasDirectTools(server.entry) ? "declared" : undefined;
}

/** The lines that name the tools `tool_search` loads: one per tool with its description, or one line of names. */
function toolLines(names: readonly ListedName[], limits: Limits): string[] {
	if (names.length === 0) return [];
	const shown = names.slice(0, limits.tools);
	if (shown.length === 0) return [`  tool_search loads ${names.length} tools`];
	const more = names.length - shown.length;
	if (limits.descriptions > 0 && shown.some((tool) => tool.description)) {
		return [
			"  tool_search loads:",
			...shown.map(({ name, description }) => {
				const text = truncate(description, limits.descriptions);
				return text ? `    ${name}: ${text}` : `    ${name}`;
			}),
			...(more > 0 ? [`    … ${more} more`] : []),
		];
	}
	return [`  tool_search loads: ${shown.map((tool) => tool.name).join(", ")}${more > 0 ? `, … ${more} more` : ""}`];
}

interface ListedName {
	name: string;
	description: string;
}

interface Limits {
	summary: number;
	instructions: number;
	/** Characters of each tool's description; 0 lists names only. */
	descriptions: number;
	tools: number;
}

/**
 * The `mcp_servers` section: every enabled server, how its tools are reached, a one-line summary, the names of the
 * tools `tool_search` loads (sorted, the server's prefix left out, each with a one-line description while they fit), and
 * an excerpt of its instructions. The model learns of the servers and their tools from it before discovery loads any.
 * Undefined when there are no servers to list.
 *
 * The `octocode` server is left out: the `octocode` section carries its whole instructions and the names of its tools
 * that `tool_search` loads (`octocodePrompt`), because the automatic server registers its tools after this is built.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter(
			(server) =>
				server.entry.name !== OCTOCODE_SERVER && server.entry.config.enabled !== false && reachOf(server) !== undefined,
		)
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const reaches = listed.map((server) => reachOf(server)!);
	const intro = reaches.includes("tool_search")
		? "MCP servers in this session. Tools of `declared` servers are in your tool list. Load a `tool_search` server's tools with `tool_search` (a tool name or capability), then call them."
		: "MCP servers in this session. Their tools are in your tool list.";
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	const texts = listed.map(serverText);
	const toolNames = listed.map((server) => {
		const prefix = `${mcpNamespace(server.entry.name)}__`;
		return [...(server.tools?.deferred ?? [])]
			.sort((a, b) => compareText(a.name, b.name))
			.map(({ name, description }) => ({
				name: name.startsWith(prefix) ? name.slice(prefix.length) : name,
				description: oneLine((description ?? "").split("\n", 1)[0] ?? ""),
			}));
	});
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with tool_search`] : [];
	const render = (kept: number, limits: Limits): string => {
		const lines = listed.slice(0, kept).flatMap((_, index) => {
			const summary = truncate(texts[index].summary, limits.summary);
			const names = toolNames[index];
			const instructions = truncate(texts[index].instructions, limits.instructions);
			return [
				summary ? `${heads[index]}: ${summary}` : heads[index],
				...toolLines(names, limits),
				...(instructions ? [`  instructions: ${instructions}`] : []),
			];
		});
		return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
	};
	// Shrink the optional parts in order until the section fits; the server lines and tool counts stay longest.
	const full = {
		summary: MAX_SERVER_DESCRIPTION_CHARS,
		instructions: MAX_SERVER_INSTRUCTIONS_CHARS,
		descriptions: MAX_TOOL_DESCRIPTION_CHARS,
		tools: MAX_LISTED_TOOLS,
	};
	const steps: Limits[] = [
		full,
		{ ...full, instructions: 200 },
		{ ...full, instructions: 0 },
		{ ...full, instructions: 0, descriptions: 0 },
		{ summary: 120, instructions: 0, descriptions: 0, tools: 12 },
		{ summary: 60, instructions: 0, descriptions: 0, tools: 0 },
		{ summary: 0, instructions: 0, descriptions: 0, tools: 0 },
	];
	for (const limits of steps) {
		const text = render(listed.length, limits);
		if (text.length <= MAX_SERVERS_SECTION_CHARS) return text;
	}
	const bare = steps.at(-1)!;
	let kept = listed.length;
	while (kept > 0 && render(kept, bare).length > MAX_SERVERS_SECTION_CHARS) kept--;
	return render(kept, bare);
}

/**
 * Whether a call that reaches `reach` (see `ToolDefinition.reachesTools`) needs the server: it
 * reaches every tool, or one of its words contains the server's namespace.
 */
export function reachesServer(reach: "all" | readonly string[], server: string): boolean {
	if (reach === "all") return true;
	// tool_search spells a namespace with every non-word character as "_"; plugin namespaces keep "-". Compare them the
	// same way so a plugin server is still waited for.
	const loose = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
	const namespace = loose(mcpNamespace(server));
	return reach.some((word) => loose(word) === namespace || loose(word).startsWith(`${namespace}__`));
}
