/**
 * Provider-neutral helpers for the shape of a tool's JSON Schema. Tool arguments are always a JSON object, but MCP and
 * JSON Schema 2020-12 let a root combine alternatives with `anyOf`/`oneOf`/`allOf` beside `type: "object"`, point at
 * shared `$defs` with `$ref`, and omit `type` where `properties` or `items` imply it. These helpers read such schemas
 * as they are, without rules for any one server.
 */

type Schema = Record<string, unknown>;

const MAX_REF_DEPTH = 16;

function isSchema(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The node a local JSON Pointer reference (`#/$defs/Filter`, `#/properties/a`) names inside `root`. */
function resolvePointer(root: unknown, ref: string): unknown {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let node: unknown = root;
	for (const raw of ref.slice(2).split("/")) {
		if (typeof node !== "object" || node === null) return undefined;
		let key: string;
		try {
			key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
		} catch {
			return undefined;
		}
		node = (node as Schema)[key];
	}
	return node;
}

/**
 * `schema` with a local `$ref` replaced by the definition it names in `root` (sibling keywords kept, as 2020-12 allows).
 * Remote, unresolvable or cyclic references return the schema unchanged.
 */
export function resolveLocalRef(schema: unknown, root: unknown): unknown {
	let current = schema;
	for (let depth = 0; depth < MAX_REF_DEPTH; depth++) {
		if (!isSchema(current) || typeof current.$ref !== "string") return current;
		const target = resolvePointer(root, current.$ref);
		if (!isSchema(target)) return current;
		const { $ref: _ref, ...siblings } = current;
		current = Object.keys(siblings).length === 0 ? target : { ...target, ...siblings };
	}
	return current;
}

/** The JSON types a schema accepts: its `type`, else `object` when it describes properties and `array` when it describes items. */
export function inferSchemaTypes(schema: Schema): string[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return stringList(schema.type);
	if (isSchema(schema.properties) || Array.isArray(schema.required) || isSchema(schema.additionalProperties)) {
		return ["object"];
	}
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return ["array"];
	return [];
}

/**
 * A JSON-encoded array or object string decoded into the container the schema expects; models sometimes send a
 * nested value as a string, occasionally encoded twice. Anything else is returned unchanged.
 */
export function parseJsonContainer(value: unknown, type: "array" | "object"): unknown {
	let current = value;
	for (let depth = 0; depth < 2 && typeof current === "string"; depth++) {
		const text = current.trim();
		if (!/^[[{"]/.test(text)) return value;
		try {
			current = JSON.parse(text);
		} catch {
			return value;
		}
	}
	if (type === "array") return Array.isArray(current) ? current : value;
	return isSchema(current) ? current : value;
}

interface LiftedObject {
	properties: Schema;
	required: Set<string>;
}

const mergedAlternatives = new WeakSet<object>();

/** Adds `source`'s properties to `target`; a key both declare differently accepts either schema. */
function mergeProperties(target: Schema, source: Schema): void {
	for (const [key, next] of Object.entries(source)) {
		const existing = target[key];
		if (existing === undefined) {
			target[key] = next;
			continue;
		}
		if (JSON.stringify(existing) === JSON.stringify(next)) continue;
		const options = mergedAlternatives.has(existing as object)
			? [...((existing as Schema).anyOf as unknown[])]
			: [existing];
		if (!options.some((option) => JSON.stringify(option) === JSON.stringify(next))) options.push(next);
		const merged = { anyOf: options };
		mergedAlternatives.add(merged);
		target[key] = merged;
	}
}

function liftObject(schema: unknown, root: unknown): LiftedObject {
	const resolved = resolveLocalRef(schema, root);
	const lifted: LiftedObject = { properties: {}, required: new Set() };
	if (!isSchema(resolved)) return lifted;
	if (isSchema(resolved.properties)) mergeProperties(lifted.properties, resolved.properties);
	for (const key of stringList(resolved.required)) lifted.required.add(key);
	if (Array.isArray(resolved.allOf)) {
		for (const part of resolved.allOf) {
			const next = liftObject(part, root);
			mergeProperties(lifted.properties, next.properties);
			for (const key of next.required) lifted.required.add(key);
		}
	}
	for (const alternatives of [resolved.anyOf, resolved.oneOf]) {
		if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
		const options = alternatives.map((option) => liftObject(option, root));
		for (const option of options) mergeProperties(lifted.properties, option.properties);
		for (const key of options[0].required) {
			if (options.every((option) => option.required.has(key))) lifted.required.add(key);
		}
	}
	return lifted;
}

/**
 * The tool schema as one plain object for providers that reject `anyOf`/`oneOf`/`allOf` at the root (Anthropic, and
 * Bedrock or Vertex when they serve Claude) and read only `properties`/`required`. Every property any alternative
 * declares is listed, a property is required only where every alternative requires it, and `$defs` stay so references
 * resolve. This only changes what the model sees: arguments are still validated against the full schema.
 * A schema without root composition is returned as is.
 */
export function liftRootComposition<T>(schema: T): T {
	if (!isSchema(schema)) return schema;
	if (!Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf) && !Array.isArray(schema.allOf)) return schema;
	const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema;
	const { properties, required } = liftObject(schema, schema);
	const { required: _required, ...withoutRequired } = rest;
	return {
		...withoutRequired,
		type: rest.type ?? "object",
		properties,
		...(required.size > 0 ? { required: [...required] } : {}),
	} as T;
}
