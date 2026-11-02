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
	/** By name in a Map: a field may be named `__proto__`, `constructor` or another `Object.prototype` member. */
	properties: Map<string, unknown>;
	required: Set<string>;
}

const mergedAlternatives = new WeakSet<object>();

/** Adds `source`'s properties to `target`; a key both declare differently accepts either schema. */
function mergeProperties(target: Map<string, unknown>, source: Iterable<[string, unknown]>): void {
	for (const [key, next] of source) {
		const existing = target.get(key);
		if (existing === undefined) {
			target.set(key, next);
			continue;
		}
		if (JSON.stringify(existing) === JSON.stringify(next)) continue;
		const options = mergedAlternatives.has(existing as object)
			? [...((existing as Schema).anyOf as unknown[])]
			: [existing];
		if (!options.some((option) => JSON.stringify(option) === JSON.stringify(next))) options.push(next);
		const merged = { anyOf: options };
		mergedAlternatives.add(merged);
		target.set(key, merged);
	}
}

/**
 * The properties and required keys `schema` describes, for a declaration the model reads: those of a local `$ref`
 * target and of the keywords beside it (every key of either side; a key both declare differently accepts either
 * schema; the required keys of both), then of `allOf` and alternatives. A schema already on the current path (a
 * reference back to the root or to an enclosing definition) is a cycle: it adds nothing the enclosing visit does not,
 * so it returns undefined and is left out, also from the keys every alternative requires. This approximates the shape
 * for a declaration only; validation resolves references itself ({@link resolveLocalRef}).
 */
function liftObject(schema: unknown, root: unknown, path: ReadonlySet<unknown> = new Set()): LiftedObject | undefined {
	if (path.has(schema)) return undefined;
	const inner = new Set(path).add(schema);
	const lifted: LiftedObject = { properties: new Map(), required: new Set() };
	if (!isSchema(schema)) return lifted;
	const target = typeof schema.$ref === "string" ? resolvePointer(root, schema.$ref) : undefined;
	const referenced = isSchema(target) ? liftObject(target, root, inner) : undefined;
	if (referenced) {
		mergeProperties(lifted.properties, referenced.properties);
		for (const key of referenced.required) lifted.required.add(key);
	}
	if (isSchema(schema.properties)) mergeProperties(lifted.properties, Object.entries(schema.properties));
	for (const key of stringList(schema.required)) lifted.required.add(key);
	if (Array.isArray(schema.allOf)) {
		for (const part of schema.allOf) {
			const next = liftObject(part, root, inner);
			if (!next) continue;
			mergeProperties(lifted.properties, next.properties);
			for (const key of next.required) lifted.required.add(key);
		}
	}
	for (const alternatives of [schema.anyOf, schema.oneOf]) {
		if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
		const options = alternatives
			.map((option) => liftObject(option, root, inner))
			.filter((option): option is LiftedObject => option !== undefined);
		if (options.length === 0) continue;
		for (const option of options) mergeProperties(lifted.properties, option.properties);
		for (const key of options[0].required) {
			if (options.every((option) => option.required.has(key))) lifted.required.add(key);
		}
	}
	// A reference back onto the path with nothing of its own beside it is that cycle too.
	const revisit = isSchema(target) && !referenced;
	if (revisit && lifted.properties.size === 0 && lifted.required.size === 0) return undefined;
	return lifted;
}

/** Keep a closed envelope only when every alternative closes exactly the lifted property names. */
function hasClosedAlternatives(schema: Schema, properties: Schema): boolean {
	const alternatives = schema.anyOf ?? schema.oneOf;
	if (!Array.isArray(alternatives) || alternatives.length === 0) return false;
	const names = Object.keys(properties);
	return alternatives.every((value) => {
		const option = resolveLocalRef(value, schema);
		if (!isSchema(option) || option.additionalProperties !== false || option.patternProperties !== undefined)
			return false;
		const declared = option.properties;
		return (
			isSchema(declared) &&
			Object.keys(declared).length === names.length &&
			names.every((name) => Object.hasOwn(declared, name))
		);
	});
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
	// The root starts the path, so it is never a revisit of itself.
	const lifted = liftObject(schema, schema);
	const properties = Object.fromEntries(lifted?.properties ?? []);
	const required = lifted?.required ?? new Set<string>();
	const { required: _required, ...withoutRequired } = rest;
	return {
		...withoutRequired,
		type: rest.type ?? "object",
		properties,
		...(rest.additionalProperties === undefined && hasClosedAlternatives(schema, properties)
			? { additionalProperties: false }
			: {}),
		...(required.size > 0 ? { required: [...required] } : {}),
	} as T;
}

/**
 * Every top-level property a tool's arguments may carry, as {@link liftRootComposition} lists them, also for a root
 * that is only a `$ref` (with or without keywords beside it). For a declaration only: it approximates the shape and is
 * not a validator.
 */
export function liftedProperties(schema: unknown): Schema {
	// Object.fromEntries defines own properties, so a field named `__proto__` stays a field.
	return Object.fromEntries(liftObject(schema, schema)?.properties ?? []);
}
