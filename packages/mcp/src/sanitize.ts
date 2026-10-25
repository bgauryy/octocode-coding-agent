/**
 * MCP servers are untrusted: their text reaches the model and the prompt. Like the built-in Octocode path, the generic
 * one shows control, bidi and invisible characters (Unicode tags, zero-width, BOM) as escapes instead of passing them on.
 */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai";
import type { Tool as McpTool } from "./client/index.ts";
import { visibleControls } from "../../coding-agent/src/octocode/shared/sanitize.ts";

/** Text blocks of a result with their characters made visible; image blocks and unchanged blocks keep their identity. */
export function visibleContent(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	return content.map((block) => {
		if (block.type !== "text") return block;
		const text = visibleControls(block.text);
		return text === block.text ? block : { ...block, text };
	});
}

/** Strings a model reads in a schema. Values such as `enum` and `const` are protocol data and stay as sent. */
const SCHEMA_TEXT_KEYS = new Set(["description", "title"]);

function visibleSchemaText(value: unknown): unknown {
	if (Array.isArray(value)) {
		const next = value.map(visibleSchemaText);
		return next.some((item, index) => item !== value[index]) ? next : value;
	}
	if (value === null || typeof value !== "object") return value;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const shown =
			typeof item === "string" && SCHEMA_TEXT_KEYS.has(key) ? visibleControls(item) : visibleSchemaText(item);
		if (shown !== item) changed = true;
		next[key] = shown;
	}
	return changed ? next : value;
}

/** A tool with its descriptions and titles (also inside its input schema) made visible; the same tool when clean. */
export function visibleTool(tool: McpTool): McpTool {
	return visibleSchemaText(tool) as McpTool;
}

/** Server instructions with their characters made visible. */
export function visibleInstructions(instructions: string | undefined): string | undefined {
	return instructions === undefined ? undefined : visibleControls(instructions);
}
