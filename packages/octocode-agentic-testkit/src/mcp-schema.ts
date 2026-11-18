/** A JSON Schema. The mock checks the keywords `schemaError` lists and ignores the rest. */
export type JsonSchema = { type?: string | string[]; enum?: unknown[]; [k: string]: unknown };

/** An object schema: the root of a tool's `inputSchema` and `outputSchema`. */
export type ObjectSchema = {
	type: "object";
	properties?: Record<string, JsonSchema>;
	required?: string[];
	[k: string]: unknown;
};

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const typeOf = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

const hasType = (t: unknown, v: unknown): boolean =>
	t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : typeOf(v) === t;

/** JSON with sorted keys, so equal values compare equal whatever their key order. */
const sameJson = (a: unknown, b: unknown): boolean => {
	const sorted = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(sorted)
			: isObject(v)
				? Object.fromEntries(
						Object.keys(v)
							.toSorted()
							.map((k) => [k, sorted(v[k])]),
					)
				: v;
	return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `$.a.b`, or `$["a b"]` for a key that is not an identifier. */
const at = (path: string, key: string): string =>
	IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

const num = (s: Obj, k: string): number | undefined => (typeof s[k] === "number" ? s[k] : undefined);

function bounds(s: Obj, path: string, size: number, min: string, max: string, unit: string): string | undefined {
	const lo = num(s, min);
	const hi = num(s, max);
	if (lo !== undefined && size < lo) return `${path} must have at least ${lo} ${unit}, got ${size}`;
	if (hi !== undefined && size > hi) return `${path} must have at most ${hi} ${unit}, got ${size}`;
	return undefined;
}

function objectError(s: Obj, value: Obj, path: string): string | undefined {
	for (const key of Array.isArray(s.required) ? s.required : [])
		if (typeof key === "string" && !Object.hasOwn(value, key)) return `${at(path, key)} is required`;
	const props = isObject(s.properties) ? s.properties : {};
	for (const [key, sub] of Object.entries(props)) {
		if (!Object.hasOwn(value, key)) continue;
		const bad = schemaError(sub, value[key], at(path, key));
		if (bad) return bad;
	}
	// `patternProperties` is not checked, so with it beside, no key can be told to be additional.
	if (s.additionalProperties === undefined || s.additionalProperties === true || s.patternProperties !== undefined)
		return undefined;
	for (const key of Object.keys(value)) {
		if (Object.hasOwn(props, key)) continue;
		if (s.additionalProperties === false) return `${at(path, key)} is not an allowed property`;
		const bad = schemaError(s.additionalProperties, value[key], at(path, key));
		if (bad) return bad;
	}
	return undefined;
}

/**
 * The first place `value` breaks `schema`, as a message starting with its JSON path (`$` is `value` itself), or
 * undefined when it conforms. Checks boolean schemas, `type` (one or a list; `integer` and `null` included), `enum`,
 * `const`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `items` (a single schema), `required`,
 * `properties` and `additionalProperties` (`false` or a schema; skipped beside `patternProperties`). Any other keyword
 * is ignored.
 */
export function schemaError(schema: unknown, value: unknown, path = "$"): string | undefined {
	if (schema === false) return `${path} is not allowed`;
	if (!isObject(schema)) return undefined;
	const s = schema;
	if (s.type !== undefined) {
		const types = Array.isArray(s.type) ? s.type : [s.type];
		if (!types.some((t) => hasType(t, value))) return `${path} must be ${types.join(" or ")}, got ${typeOf(value)}`;
	}
	if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value)))
		return `${path} must be one of ${JSON.stringify(s.enum)}, got ${JSON.stringify(value)}`;
	if (Object.hasOwn(s, "const") && !sameJson(s.const, value))
		return `${path} must be ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`;
	// oxlint-disable-next-line typescript/no-misused-spread -- JSON Schema measures string length in code points
	if (typeof value === "string") return bounds(s, path, [...value].length, "minLength", "maxLength", "characters");
	if (typeof value === "number") {
		const lo = num(s, "minimum");
		const hi = num(s, "maximum");
		if (lo !== undefined && value < lo) return `${path} must be >= ${lo}, got ${value}`;
		if (hi !== undefined && value > hi) return `${path} must be <= ${hi}, got ${value}`;
		return undefined;
	}
	if (Array.isArray(value)) {
		const size = bounds(s, path, value.length, "minItems", "maxItems", "items");
		if (size || (!isObject(s.items) && typeof s.items !== "boolean")) return size;
		for (const [i, item] of value.entries()) {
			const bad = schemaError(s.items, item, `${path}[${i}]`);
			if (bad) return bad;
		}
		return undefined;
	}
	return isObject(value) ? objectError(s, value, path) : undefined;
}
