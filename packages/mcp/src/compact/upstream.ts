/**
 * What a preset override replaces, read from the server's own schema: the description of a tool and of each field at
 * its dotted path (as `DescriptionOverrides.fields` addresses it). An override is kept while the text it replaces is
 * unchanged, whatever else the server changed (formatting, field order, `$defs`, other fields, an added example).
 */

import { createHash } from "node:crypto";
import { OUTPUT_FIELD_PREFIX } from "./render.ts";
import { schemaToTs } from "./schema-to-ts.ts";
import type { CompactToolInput, JsonSchema } from "./types.ts";

/** Short digest of the upstream texts an override replaces; collisions are not a concern at this size. */
export const upstreamHash = (texts: readonly string[]): string =>
	createHash("sha256").update(JSON.stringify(texts)).digest("hex").slice(0, 16);

/** The texts of one tool description: none when the server sends none. */
export const toolDescriptionTexts = (tool: CompactToolInput): string[] =>
	tool.description?.trim() ? [tool.description] : [];

/**
 * Each field path of the tool (output fields `output.`-prefixed) to the distinct descriptions the schema gives it,
 * sorted: a field a union repeats in several variants has one path and every variant's text. A field without a
 * description has an empty list, so an override written for no text is told from one written for a text.
 */
export function fieldUpstreamTexts(tool: CompactToolInput): Map<string, string[]> {
	const found = new Map<string, Set<string>>();
	const collect = (schema: JsonSchema, prefix: string) =>
		schemaToTs(schema, {
			scope: "U_",
			onField: (path, _required, description) => {
				const texts = found.get(prefix + path) ?? new Set<string>();
				if (description.trim()) texts.add(description);
				found.set(prefix + path, texts);
			},
		});
	collect(tool.inputSchema, "");
	if (tool.outputSchema !== undefined) collect(tool.outputSchema, OUTPUT_FIELD_PREFIX);
	return new Map([...found].map(([path, texts]) => [path, [...texts].sort()]));
}
