import type { TextContent } from "../types.ts";

/** Select public output fields before rendering; callers never pass a whole provider event. */
export function outputFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object") return {};
	const source = value as Record<string, unknown>;
	return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/** A tool's JSON-string arguments/results need the same metadata filtering as structured results. */
function outputValue(value: unknown): unknown {
	if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** Readable provider-tool output with continuation material removed before it enters display content. */
export function providerOutputText(type: string, fields: Record<string, unknown>): TextContent {
	const text = JSON.stringify(
		fields,
		(key, value: unknown) => {
			const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
			if (
				/signature|encrypted|fingerprint|context|authorization|cookie|headers|secret/.test(normalized) ||
				normalized.endsWith("token") ||
				normalized === "apikey"
			)
				return undefined;
			return ["arguments", "args", "input", "response", "result", "output"].includes(key) ? outputValue(value) : value;
		},
		2,
	);
	return { type: "text", text: `Provider output: ${type}\n\n\`\`\`json\n${text}\n\`\`\`` };
}
