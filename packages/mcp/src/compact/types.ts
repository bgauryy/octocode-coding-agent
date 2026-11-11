/** A JSON Schema node as MCP servers send it: an object, or `true`/`false` for always/never valid. */
export type JsonSchema = boolean | { [key: string]: unknown };

export interface CompactToolInput {
	name: string;
	description?: string;
	inputSchema: JsonSchema;
	outputSchema?: JsonSchema;
}

export interface CompactServerInput {
	server: string;
	instructions?: string;
	tools: readonly CompactToolInput[];
	/**
	 * The name the model calls each tool by, by MCP tool name (`assignMcpToolNames`). A session passes the names its
	 * registry assigned; without it, names are assigned as for a server with this call name and no other servers.
	 */
	toolNames?: Readonly<Record<string, string>>;
}

/**
 * Model-written description text. Structure always comes from the schema; overrides replace prose only.
 * `fields` maps a tool name to dotted property paths (`queries.path`, `responseChars`): array items and union variants
 * are transparent, so a field shared by every variant has one path. A path starting with `output.` addresses the tool's
 * output schema (`output.results.path`).
 */
export interface DescriptionOverrides {
	server?: string;
	tools?: Record<string, string>;
	/**
	 * One line per tool saying when to use it (condition beside action, naming the sibling that fits better): the
	 * description of the tool's thin provider declaration. The file keeps the full description.
	 */
	triggers?: Record<string, string>;
	fields?: Record<string, Record<string, string>>;
}

/** One hash, or the hashes a text had in the catalogs the override was written for (a server varies a field by configuration). */
export type UpstreamHashes = string | string[];

interface KeyedFieldOverride {
	/** `upstreamHash` of the description(s) the field has upstream at its path. */
	upstream: UpstreamHashes;
	text: string;
}

export interface PresetToolOverrides {
	/** `upstreamHash` of the tool's description, which `description` and `trigger` were written for. */
	descriptionHash?: UpstreamHashes;
	description?: string;
	trigger?: string;
	/** By dotted field path (`queries.path`, `output.results.path`). */
	fields?: Record<string, KeyedFieldOverride>;
}

/**
 * Overrides as `octocode mcp compact apply` stores them: each keyed on the upstream text it replaces, so it applies
 * exactly while that text is unchanged (`presetOverridesFor`).
 */
export interface PresetOverrides {
	server?: { instructionsHash: string; text: string };
	tools?: Record<string, PresetToolOverrides>;
}

export interface GeneratedMeta {
	/** {@link catalogHash} of the catalog the text was rendered from. */
	hash: string;
	generatorVersion: number;
	/** What the text was rendered with: the stored overrides that describe the catalog. */
	overrides?: DescriptionOverrides;
	/** The overrides stored for this server (`octocode mcp compact apply`), kept whole while parts of them are stale. */
	authored?: PresetOverrides;
	/**
	 * Written only before overrides were keyed: {@link toolHash} of each tool and the instructions' hash, which
	 * `authoredOverrides` reads once to key a file's overrides.
	 */
	toolHashes?: Record<string, string>;
	instructionsHash?: string;
	/**
	 * Written only by releases that shipped overrides with a preset: a hash of those the text was rendered with. A file
	 * that has it is rendered again (`resolveServerFile`).
	 */
	presetHash?: string;
	optimizedBy?: { model: string; at: string };
	generatedAt: string;
}
