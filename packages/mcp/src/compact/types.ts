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

export interface GeneratedMeta {
	/** {@link catalogHash} of the catalog the text was rendered from. */
	hash: string;
	generatorVersion: number;
	generatedAt: string;
}
