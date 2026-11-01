/**
 * Adapts MCP tools to Octocode tool definitions.
 *
 * Results map onto Octocode's model-facing content (text and images). Text over the shared 20 KB result default (`spillOutput`) keeps its start and
 * end with the middle cut out, like Codex does, and the full text is saved to a temp file the model
 * can read. Programmatic callers receive the supported `CallToolResult` without `_meta`
 * (supported `content` blocks, `structuredContent`, `isError`), never truncated: it is
 * the tool's `structuredContent`, and every MCP tool declares a `CallToolResult` output schema. MCP
 * errors (`isError`) are error results for the model, but programmatic consumers retain the structured result.
 */

import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { ImageContent, JsonValue, TextContent } from "@octocodeai/octocode-ai";
import { type CallToolResult, type McpRequestOptions, toLlmContent } from "./client/index.ts";
import type { TSchema } from "typebox";
import { hostOutput } from "./host.ts";
import { visibleContent } from "./sanitize.ts";

export interface McpToolDetails {
	server: string;
	tool: string;
	/** Temp file with the full text output, when the model-facing text was truncated. */
	fullOutputPath?: string;
}

/**
 * Saves the full text of a truncated result, and returns the file path.
 * `extension` includes the dot, for example `.txt`.
 */
type McpOutputSaver = (data: string | Uint8Array, extension: string) => string | undefined;

export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * MCP content blocks as one schema for programmatic result consumers.
 */
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` (`#/properties/structuredContent`) of
 * another schema: its local references (`#`, `#/$defs/Item`) are rewritten to point below
 * `pointer`, so they resolve to the same subschemas as before.
 */
function relocateSchema(schema: unknown, pointer: string): unknown {
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	if (typeof schema !== "object" || schema === null) return schema;
	const relocated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	return relocated;
}

/** Whether `ref` points at something in `root`: the root, an existing JSON pointer, or a declared anchor. */
function resolvesWithin(root: unknown, ref: string): boolean {
	if (ref === "#") return true;
	if (ref.startsWith("#/")) {
		let node: unknown = root;
		for (const segment of ref.slice(2).split("/")) {
			let key: string;
			try {
				key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
			} catch {
				return false;
			}
			if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return false;
			node = (node as Record<string, unknown>)[key];
		}
		return true;
	}
	return ref.startsWith("#") && declaresAnchor(root, ref.slice(1));
}

function declaresAnchor(schema: unknown, name: string): boolean {
	if (Array.isArray(schema)) return schema.some((item) => declaresAnchor(item, name));
	if (typeof schema !== "object" || schema === null) return false;
	const { $anchor, $id } = schema as Record<string, unknown>;
	return $anchor === name || $id === `#${name}` || Object.values(schema).some((value) => declaresAnchor(value, name));
}

/**
 * `schema` without the `$ref`s that cannot resolve (remote documents, missing definitions): the host's validator
 * cannot compile them and would reject every call of the tool, while the server validates its own input anyway.
 * The rest of the subschema (siblings of the `$ref`) still applies; a bare `$ref` becomes the permissive `{}`.
 */
function dropUnresolvableRefs(schema: unknown, root: unknown = schema): unknown {
	if (Array.isArray(schema)) return schema.map((item) => dropUnresolvableRefs(item, root));
	if (typeof schema !== "object" || schema === null) return schema;
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string") {
			if (resolvesWithin(root, value)) cleaned[key] = value;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			cleaned[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			cleaned[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, dropUnresolvableRefs(subschema, root)]),
			);
		} else {
			cleaned[key] = dropUnresolvableRefs(value, root);
		}
	}
	return cleaned;
}

/**
 * Output schema of every MCP tool: the structured `CallToolResult` (without `_meta`, which
 * {@link convertMcpResult} drops), with the tool's own output schema as `structuredContent`.
 */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			// Servers may send structured content without declaring a schema for it, and it may be any JSON value.
			structuredContent: structuredContentSchema
				? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: {},
			isError: { type: "boolean" },
		},
		required: ["content"],
		// Fields newer protocol versions add.
		additionalProperties: true,
	};
}

/**
 * Keep model-facing text within the shared result default (`spillOutput`'s `maxBytes`). Longer text is saved whole and becomes one text block with its
 * start and end and the file's path (`spillOutput`, shared with the Octocode server's results, which has its own budget);
 * images follow it.
 */
function limitMcpContent(
	content: (TextContent | ImageContent)[],
	label: string,
	saveOutput?: McpOutputSaver,
): { content: (TextContent | ImageContent)[]; fullOutputPath?: string } {
	const spilled = hostOutput().spillOutput(textOf(content), {
		label: `mcp ${label}`,
		// The budget is bytes; MCP text has no line limit.
		maxLines: Number.MAX_SAFE_INTEGER,
		...(saveOutput ? { save: (text: string) => saveOutput(text, ".txt") } : {}),
	});
	if (!spilled.truncated) return { content };
	return {
		content: [{ type: "text", text: spilled.text }, ...content.filter((block) => block.type === "image")],
		...(spilled.file ? { fullOutputPath: spilled.file } : {}),
	};
}

interface ConvertMcpResultOptions {
	saveOutput?: McpOutputSaver;
}

/** Convert an MCP result. `isError` results become error results that keep the structured result. */
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	options: ConvertMcpResultOptions = {},
): Promise<AgentToolResult<McpToolDetails>> {
	// Without content blocks, toLlmContent falls back to the structured content as JSON.
	const converted = visibleContent(toLlmContent(result));
	if (result.isError && textOf(converted) === "") {
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	}
	const { content, fullOutputPath } = limitMcpContent(converted, `${server}/${tool}`, options.saveOutput);
	const { _meta: _ignored, ...structuredResult } = result;
	return {
		content,
		details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		structuredContent: structuredResult as unknown as JsonValue,
		...(result.isError ? { isError: true } : {}),
	};
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`. References that cannot resolve are dropped (see {@link dropUnresolvableRefs}).
 */
export function toParameters(schema: Record<string, unknown>): TSchema {
	return {
		...(dropUnresolvableRefs(schema) as Record<string, unknown>),
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	};
}
