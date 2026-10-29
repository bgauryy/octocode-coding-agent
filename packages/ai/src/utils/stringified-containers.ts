import { inferSchemaTypes, resolveLocalRef } from "./json-schema-shape.ts";

/** Unambiguous container fields across a root `anyOf`/`oneOf`; conflicting alternatives stay with union coercion. */
function topLevelContainerTypes(schema: unknown): Map<string, "array" | "object" | undefined> {
	const out = new Map<string, "array" | "object" | undefined>();
	if (!schema || typeof schema !== "object") return out;
	const root = schema as Record<string, unknown>;
	const branches = Array.isArray(root.anyOf) ? root.anyOf : Array.isArray(root.oneOf) ? root.oneOf : [];
	for (const source of [root, ...(branches as unknown[])]) {
		const properties = (source as { properties?: Record<string, unknown> } | null)?.properties;
		if (!properties || typeof properties !== "object") continue;
		for (const [key, property] of Object.entries(properties)) {
			const node = resolveLocalRef(property, schema);
			const types = node && typeof node === "object" ? inferSchemaTypes(node as Record<string, unknown>) : [];
			const type = types.length === 1 && (types[0] === "array" || types[0] === "object") ? types[0] : undefined;
			out.set(key, out.has(key) && out.get(key) !== type ? undefined : type);
		}
	}
	return out;
}

/**
 * When normal schema coercion fails, recover array or object fields sent as JSON strings by models given open
 * declarations (thin MCP stubs). Parse them in place so errors report the mistake inside (`queries.0.line`) rather than
 * "must be array". Strings that are not JSON of the declared container type stay as sent. Returns whether a field changed.
 */
export function parseStringifiedContainers(args: unknown, schema: unknown): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const record = args as Record<string, unknown>;
	let changed = false;
	for (const [key, type] of topLevelContainerTypes(schema)) {
		if (type === undefined) continue;
		const value = record[key];
		if (typeof value !== "string" || !/^\s*[[{]/.test(value)) continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (parsed !== null && typeof parsed === "object" && (type === "array") === Array.isArray(parsed)) {
				record[key] = parsed;
				changed = true;
			}
		} catch {
			// Not JSON: leave the string for validation to report.
		}
	}
	return changed;
}
