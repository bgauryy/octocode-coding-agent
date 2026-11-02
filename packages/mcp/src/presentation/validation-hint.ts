import { declaresReason } from "./declaration.ts";

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
 * required keys, with its optional keys named. Undefined when the root declares no required key. `reason` is named only
 * when the server declares it: otherwise the host drops it before the call.
 */
export function envelopeHint(toolName: string, schema: Record<string, unknown>): string | undefined {
	const serverReason = declaresReason(schema);
	const named = (key: string) => serverReason || key !== "reason";
	const rootProperties = propertiesOf(schema);
	const forms: string[] = [];
	const optional = new Set<string>();
	for (const shape of rootShapes(schema)) {
		const properties = { ...rootProperties, ...propertiesOf(shape) };
		const required = Array.isArray(shape.required)
			? (shape.required as unknown[]).filter((key): key is string => typeof key === "string" && named(key))
			: [];
		if (required.length === 0) continue;
		forms.push(`{${required.map((key) => `"${key}":${placeholder(properties[key])}`).join(",")}}`);
		for (const key of Object.keys(properties)) if (!required.includes(key) && named(key)) optional.add(key);
	}
	if (forms.length === 0) return undefined;
	const extra = optional.size > 0 ? ` Optional beside the first form: ${[...optional].join(", ")}.` : "";
	return `${toolName} takes only ${forms.join(" or ")} as its arguments, with no other top-level property.${extra}`;
}
