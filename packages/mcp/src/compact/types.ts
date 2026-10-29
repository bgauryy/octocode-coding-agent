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

export interface GeneratedMeta {
	/** {@link catalogHash} of the catalog the text was rendered from. */
	hash: string;
	generatorVersion: number;
	/** {@link toolHash} of each tool, so overrides of unchanged tools survive a change to other tools. */
	toolHashes?: Record<string, string>;
	/** {@link instructionsHash} of the server instructions, so a server override survives a change to tools only. */
	instructionsHash?: string;
	overrides?: DescriptionOverrides;
	/** {@link presetHash} of the preset overrides the text was rendered with; absent without a preset. */
	presetHash?: string;
	optimizedBy?: { model: string; at: string };
	generatedAt: string;
}
