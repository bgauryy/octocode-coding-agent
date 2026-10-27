/**
 * Tool discovery: a BM25 ranker over registered tool metadata.
 *
 * `tool_search` searches tools that are not declared to
 * the model (`deferred` exposure) and loads the matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change. Loaded tools survive `/tree`, resume and fork: the session restores those that the
 * `--tools` allowlist and the tool policy permit. A tool outside the allowlist is not restored, and `/tree` drops
 * tools loaded only on another branch.
 */

import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../extensions/types.ts";
import { isRecord } from "../../utils/guards.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/** Whether a registered `tool_search` can load deferred tools, so deferred exposure is usable. */
export function canDiscoverTools(pi: Partial<Pick<ExtensionAPI, "getAllTools">>): boolean {
	return pi.getAllTools?.().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools) ?? false;
}

/** Sessions (by extension API) whose `tool_search` was active once since the loadout was last rebuilt. */
const discoveryOffered = new WeakSet<object>();

/**
 * Activates `tool_search` for deferred tools when it is registered and can reach them. It offers the tool once: when
 * the tool was active and a later `setActiveTools` left it out, that deselection stands. Call
 * {@link resetDiscoveryActivation} when the loadout is rebuilt from elsewhere (session start, tree navigation).
 */
export function activateDiscovery(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools">): void {
	try {
		const active = pi.getActiveTools();
		if (active.includes(TOOL_SEARCH_TOOL_NAME)) {
			discoveryOffered.add(pi);
			return;
		}
		if (discoveryOffered.has(pi) || !canDiscoverTools(pi)) return;
		discoveryOffered.add(pi);
		pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
	} catch {
		// The session is shutting down or not bound yet; the next registration retries.
	}
}

/** Forget that discovery was active, so the next {@link activateDiscovery} offers `tool_search` again. */
export function resetDiscoveryActivation(pi: object): void {
	discoveryOffered.delete(pi);
}
const DEFAULT_TOOL_SEARCH_LIMIT = 8;
/**
 * A ranked match loads only when it scores at least this fraction of the best match, so a generic query ("search")
 * loads the strong matches instead of every tool that mentions it. A tool the query names exactly always loads.
 */
const RELEVANCE_CUTOFF = 0.5;

/** A tool as the ranker sees it: its name and the text built by {@link createToolSearchDocument}. */
interface ToolSearchDocument {
	name: string;
	text: string;
}

interface ToolSearchMatch {
	name: string;
	score: number;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (!/^[a-z]+$/.test(term)) return term;
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
	return text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^\p{L}\p{M}\p{N}]+/u)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isRecord(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isRecord(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/**
 * Search text of a tool: the name, the name with `_`
 * as spaces, the description, schema descriptions and property names, and the namespace with its
 * description and instructions.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Okapi BM25 with the usual parameters. Ties keep document order. */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
		const termCounts = documents.map((document) => {
			const counts = new Map<string, number>();
			for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
			return counts;
		});
		const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
		const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
		const idf = new Map(
			queryTerms.map((term) => {
				const frequency = termCounts.filter((counts) => counts.has(term)).length;
				return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const matches: ToolSearchMatch[] = [];
		documents.forEach((document, index) => {
			let score = 0;
			for (const term of queryTerms) {
				const count = termCounts[index].get(term);
				if (!count) continue;
				const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
				score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
			}
			if (score > 0) matches.push({ name: document.name, score });
		});
		return matches.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	namespace: Type.Optional(
		Type.String({ description: "Limit discovery to a namespace or MCP server name from the available server list." }),
	),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

interface ToolSearchResultTool {
	name: string;
	description: string;
}

interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
}

interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

function normalizeNamespace(name: string): string {
	return name
		.trim()
		.replace(/^mcp__/, "")
		.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Whether `tool_search` can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "deferred";
}

interface SearchOutcome {
	loaded: ToolSearchResultTool[];
	/** Tools that matched the query, loaded or not: exact names and ranked matches. */
	matched: number;
	/** Matching deferred tools that are active already. */
	alreadyLoaded: string[];
	/** Namespaces with tools left to load, and how many each has. */
	searchable: Map<string, number>;
}

/** Whether `name` is the tool's full name, or its name after the namespace prefix (`mcp__server__`). */
function namesTool(tool: Pick<ToolInfo, "name" | "namespace">, name: string): boolean {
	const prefix = tool.namespace?.name ? `${tool.namespace.name}__` : undefined;
	return tool.name === name || (prefix !== undefined && tool.name === `${prefix}${name}`);
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so the next model
 * call declares them; a tool the query names exactly comes first. Activation is recorded in the transcript like any
 * tool change. Also reports matching tools that are loaded already and what is left to search, for the result text.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
	namespace?: string,
): SearchOutcome {
	const active = tools.getActiveTools();
	const inScope = tools
		.getAllTools()
		.filter(
			(tool) =>
				isSearchable(tool.exposure) &&
				(namespace === undefined ||
					[tool.namespace?.name, ...(tool.namespace?.aliases ?? [])].some(
						(name) => name !== undefined && normalizeNamespace(name) === normalizeNamespace(namespace),
					)),
		);
	const candidates = inScope.filter((tool) => !active.includes(tool.name));
	const ranker = new Bm25Ranker();
	// Exact names first, then the ranked matches that pass the relevance cutoff; `matched` counts all of them.
	const select = (pool: typeof inScope) => {
		const named = pool.filter((tool) => namesTool(tool, query.trim())).map((tool) => tool.name);
		const ranked = ranker.rank(
			query,
			pool.map((tool) => createToolSearchDocument(tool, tool.namespace)),
			pool.length,
		);
		const floor = (ranked[0]?.score ?? 0) * RELEVANCE_CUTOFF;
		const strong = ranked.filter((match) => match.score >= floor).map((match) => match.name);
		return {
			matched: new Set([...named, ...ranked.map((match) => match.name)]).size,
			names: [...new Set([...named, ...strong])],
		};
	};
	const { matched, names } = select(candidates);
	const matches = names.slice(0, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches]);
	const alreadyLoaded = select(inScope.filter((tool) => active.includes(tool.name))).names.slice(0, limit);
	const searchable = new Map<string, number>();
	for (const tool of candidates) {
		const key = tool.namespace?.name ?? "other";
		searchable.set(key, (searchable.get(key) ?? 0) + 1);
	}
	return {
		matched,
		loaded: matches.map((name) => ({
			name,
			description: candidates.find((tool) => tool.name === name)?.description ?? "",
		})),
		alreadyLoaded,
		searchable,
	};
}

/** The result text: what loaded, what was loaded already, or, when nothing matched, what is left to search. */
function resultText(query: string, outcome: SearchOutcome): string {
	const { loaded, matched, alreadyLoaded, searchable } = outcome;
	const already = alreadyLoaded.length > 0 ? [`Already loaded, call directly: ${alreadyLoaded.join(", ")}`] : [];
	if (loaded.length > 0)
		return [
			matched > loaded.length
				? `Loaded ${loaded.length} of ${matched} matching tools (the closest ones; use more specific words to find the rest). They are available from your next call:`
				: `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:`,
			...loaded.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`),
			...already,
		].join("\n");
	if (already.length > 0) return already[0];
	if (searchable.size === 0)
		return "No matching tools found. No tools are waiting to be loaded; your declared tools are all there is.";
	const namespaces = [...searchable]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, count]) => `${name} (${count} tool${count === 1 ? "" : "s"})`)
		.join(", ");
	return `No matching tools found for ${JSON.stringify(query.trim())}. Searchable: ${namespaces}. Retry with a tool name from the mcp_servers section, other capability words, or a namespace.`;
}

/**
 * The `tool_search` description. It does not list the searchable tools or their namespaces, so it
 * stays the same while tools are registered, for example when MCP servers connect.
 */
export const TOOL_SEARCH_DESCRIPTION =
	"Find and load tools for the next call. Search by the capability you need; use namespace to target one MCP server without waiting for unrelated servers. After discovery, call the loaded tool directly with its declared arguments.";

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		reachesTools: (input) =>
			typeof input.namespace === "string" && input.namespace.trim()
				? [`mcp__${normalizeNamespace(input.namespace)}`]
				: "all",
		async execute(_toolCallId, { query, limit, namespace }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			if (namespace !== undefined && !namespace.trim()) throw new Error("namespace must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const outcome: SearchOutcome = options.tools
				? searchAndLoad(options.tools, query, max, namespace)
				: { loaded: [], matched: 0, alreadyLoaded: [], searchable: new Map() };
			return {
				content: [{ type: "text", text: resultText(query, outcome) }],
				details: { loaded: outcome.loaded.map((tool) => tool.name) },
			};
		},
	};
}

/**
 * Registers discovery, inactive until something needs it. MCP activates it when a server's tools are deferred
 * (`mcp/src/tool-registry.ts`); a native tool registered with `exposure: "deferred"` (the graph tools) has no server to do
 * so, and without `tool_search` it would be neither declared nor loadable, so any registered deferred tool activates it.
 * Hosts without native features can add it explicitly.
 */
export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });
		const offerForDeferredTools = () => {
			if (pi.getAllTools().some((tool) => tool.exposure === "deferred")) activateDiscovery(pi);
		};
		// Every extension has registered its tools by session start; a tool registered later is covered by the next turn.
		pi.on("session_start", offerForDeferredTools);
		pi.on("before_agent_start", offerForDeferredTools);
	};
}
