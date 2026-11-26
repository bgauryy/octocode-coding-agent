/**
 * Code-only sensors for a MEMORY.md line that may no longer hold: a tool field the line says the tool refuses, which the
 * tool now takes. A hit only marks the line `recheck`; it never removes it.
 */

/** The names of every property in a tool's parameter schema, nested ones included. */
function propertyNames(schema: unknown, into: Set<string> = new Set()): Set<string> {
	if (typeof schema !== "object" || schema === null) return into;
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && typeof value === "object" && value !== null) {
			for (const [name, sub] of Object.entries(value)) {
				into.add(name);
				propertyNames(sub, into);
			}
		} else propertyNames(value, into);
	}
	return into;
}

/** Each tool's field names, by tool name. */
export function toolFieldMap(
	tools: ReadonlyArray<{ name: string; parameters?: unknown }>,
): ReadonlyMap<string, ReadonlySet<string>> {
	return new Map(tools.map((tool) => [tool.name, propertyNames(tool.parameters)]));
}

const REFUSAL = /\b(?:does not accept|doesn't accept|rejects?|refuses|unknown|not supported|invalid)\b/i;
const FIELD_WORD = /`?([A-Za-z_]\w*)`?\s+(?:property|field|parameter|key|argument)\b/gi;

/**
 * The first field `text` calls refused for a tool it names that the tool now takes, as `notify takes job`. Lines that say
 * nothing is refused, or name no registered tool, are not judged.
 */
export function acceptedToolField(
	text: string,
	tools: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): string | undefined {
	if (!tools || !REFUSAL.test(text)) return undefined;
	const fields = [...text.matchAll(FIELD_WORD)].map((match) => match[1]);
	if (fields.length === 0) return undefined;
	const words = new Set(text.toLowerCase().match(/[a-z_][\w-]*/g));
	for (const [tool, known] of tools) {
		if (!words.has(tool.toLowerCase())) continue;
		const field = fields.find((each) => known.has(each));
		if (field) return `${tool} takes ${field}`;
	}
	return undefined;
}
