import type { ToolValidationFailure } from "@octocodeai/octocode-ai";
import { resolveLocalRef } from "@octocodeai/octocode-ai/utils/json-schema-shape";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The objects a tool's root schema accepts: its alternatives (`anyOf`/`oneOf`) or the schema itself. */
function rootShapes(schema: Record<string, unknown>): Record<string, unknown>[] {
	const branches = schema.anyOf ?? schema.oneOf;
	return Array.isArray(branches) && branches.length > 0
		? branches.filter((branch): branch is Record<string, unknown> => typeof branch === "object" && branch !== null)
		: [schema];
}

const propertiesOf = (shape: Record<string, unknown>): Record<string, Record<string, unknown> | undefined> =>
	(shape.properties as Record<string, Record<string, unknown> | undefined> | undefined) ?? {};

/** The `queries` batch size a server's schema caps (maxItems), when it declares one at the root or in a root alternative. */
export function queriesCap(schema: Record<string, unknown>): number | undefined {
	for (const shape of [schema, ...rootShapes(schema)]) {
		const cap = propertiesOf(shape).queries?.maxItems;
		if (typeof cap === "number") return cap;
	}
	return undefined;
}

function placeholder(property: Record<string, unknown> | undefined): string {
	switch (property?.type) {
		case "array":
			return "[...]";
		case "object":
			return "{...}";
		case "string":
			return '"..."';
		default:
			return "...";
	}
}

/**
 * The call shapes a tool accepts at the top level, for a failure whose problems are all root properties (a foreign
 * envelope such as `type`, `timeout` or `background`): one `{"key":value}` form per root alternative, built from its
 * required keys, with its optional keys named. Undefined when the root declares no required key. All field names come
 * from the server's schema; a hint adds no requirement or restriction on additional properties.
 */
export function envelopeHint(toolName: string, schema: Record<string, unknown>): string | undefined {
	const rootProperties = propertiesOf(schema);
	const requiredKeys = (shape: Record<string, unknown>): string[] =>
		Array.isArray(shape.required) ? shape.required.filter((key): key is string => typeof key === "string") : [];
	const forms: string[] = [];
	const optional = new Set<string>();
	for (const shape of rootShapes(schema)) {
		const properties = { ...rootProperties, ...propertiesOf(shape) };
		const required = [...new Set([...requiredKeys(schema), ...requiredKeys(shape)])];
		if (required.length === 0) return undefined;
		forms.push(`{${required.map((key) => `"${key}":${placeholder(properties[key])}`).join(",")}}`);
		for (const key of Object.keys(properties)) if (!required.includes(key)) optional.add(key);
	}
	if (forms.length === 0) return undefined;
	const extra =
		optional.size > 0
			? ` Other declared fields: ${[...optional].join(", ")}; follow the server's schema for each form.`
			: "";
	return `${toolName} requires ${forms.join(" or ")} at the top level.${extra}`;
}

/** Field names at the actual rejecting schema, including a selected union branch or local reference. */
export function siblingHint(
	schema: Record<string, unknown>,
	unexpected: ToolValidationFailure["unexpected"],
	envelope?: string,
): string | undefined {
	const lines = new Set<string>();
	let length = envelope?.length ?? 0;
	for (const { instancePath, schemaPath, names } of unexpected ?? []) {
		if (!schemaPath) {
			lines.add("Load the full schema for the remaining rejected fields.");
			continue;
		}
		let node: unknown = resolveLocalRef(schema, schema);
		for (const segment of schemaPath.split("/").slice(1)) {
			const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
			if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) {
				node = undefined;
				break;
			}
			node = resolveLocalRef((node as Record<string, unknown>)[key], schema);
		}
		if (!isRecord(node) || !isRecord(node.properties)) continue;
		const fields = Object.keys(node.properties);
		if (!fields.length) continue;
		for (const name of names) {
			const field = name.slice(0, -1);
			if (!name.endsWith(":") || !Object.hasOwn(node.properties, field)) continue;
			const line = `Use ${JSON.stringify(field)} for the rejected key ${JSON.stringify(name)} at ${instancePath || "root"}.`;
			if (length + line.length <= 1000 && !lines.has(line)) {
				lines.add(line);
				length += line.length + 1;
			}
		}
		if (envelope) continue;
		const prefix = `Declared fields at ${instancePath || "root"}: `;
		const shown: string[] = [];
		let size = prefix.length;
		for (const field of fields) {
			size += field.length + 2;
			if (length + size > 1000) {
				if (shown.length) lines.add(`${prefix}${shown.join(", ")}.`);
				lines.add("Load the full schema for all fields.");
				return [...lines].join("\n");
			}
			shown.push(field);
		}
		const line = `${prefix}${shown.join(", ")}.`;
		if (!lines.has(line)) length += line.length + 1;
		lines.add(line);
	}
	if (envelope) lines.add(envelope);
	return [...lines].join("\n") || (unexpected?.length ? "Load the full schema for the rejected fields." : undefined);
}
