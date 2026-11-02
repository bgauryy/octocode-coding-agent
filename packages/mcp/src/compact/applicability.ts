import { isNode, type Node } from "./schema-nodes.ts";
import type { JsonSchema } from "./types.ts";

/**
 * Servers that describe one flat object for several operations state, in each field's description, when the field
 * applies ("Only with operation: a, b.", "Not with operation: c.", "Required with operation: a.", "Required except with
 * operation: c."). Repeated per field that is a lot of prose; this pre-pass reads the notes and rebuilds the schema as the
 * shared fields plus one variant per operation group, which `schemaToTs` renders as `Shared & ({ operation: "a"; ... } | ...)`.
 * A field whose notes cannot be read keeps its text, and an object without readable notes is left as it is.
 */

const NOTE_KINDS = "Only with|Not with|Required with|Required except with";

type Kind = "only" | "not" | "required" | "requiredExcept";
interface Rule {
	kind: Kind;
	values: string[];
}

const KIND_OF: Record<string, Kind> = {
	"Only with": "only",
	"Not with": "not",
	"Required with": "required",
	"Required except with": "requiredExcept",
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The notes about `key` in a description, and the description without them; undefined when a note names a value the key lacks. */
function readNotes(
	description: string,
	key: string,
	values: ReadonlySet<string>,
): { rules: Rule[]; rest: string } | undefined {
	const pattern = new RegExp(`(^|\\s)(${NOTE_KINDS}) ${escapeRegExp(key)}: ([\\w$-]+(?:, [\\w$-]+)*)\\.`, "g");
	const rules: Rule[] = [];
	let invalid = false;
	const rest = description.replace(pattern, (_whole, _lead: string, kind: string, list: string) => {
		const names = list.split(", ");
		if (names.some((name) => !values.has(name))) invalid = true;
		rules.push({ kind: KIND_OF[kind], values: names });
		return " ";
	});
	if (invalid || !rules.length) return undefined;
	return { rules, rest: rest.replace(/\s{2,}/g, " ").trim() };
}

const stripped = (property: Node, rest: string): Node => {
	const { description: _description, ...others } = property;
	return rest ? { ...others, description: rest } : others;
};

const stringEnum = (property: unknown): string[] | undefined =>
	isNode(property) &&
	Array.isArray(property.enum) &&
	property.enum.length > 1 &&
	property.enum.every((value) => typeof value === "string")
		? property.enum
		: undefined;

const mentions = (property: unknown, key: string) =>
	isNode(property) && typeof property.description === "string" && property.description.includes(` with ${key}: `);

const allows = (rules: readonly Rule[], operation: string) =>
	rules.every((rule) =>
		rule.kind === "only"
			? rule.values.includes(operation)
			: rule.kind === "not"
				? !rule.values.includes(operation)
				: true,
	);

interface Reading {
	property: Node;
	rest: string;
	allowed: boolean[];
	required: boolean[];
}

function restructure(node: Node): Node {
	if (node.anyOf || node.oneOf || node.allOf || !isNode(node.properties)) return node;
	const properties = node.properties;
	const keys = Object.keys(properties);
	let key: string | undefined;
	let most = 0;
	for (const candidate of keys) {
		if (!stringEnum(properties[candidate])) continue;
		const count = keys.filter((other) => other !== candidate && mentions(properties[other], candidate)).length;
		if (count > most) {
			most = count;
			key = candidate;
		}
	}
	if (key === undefined) return node;
	const discriminator = properties[key] as Node;
	const operations = stringEnum(discriminator) as string[];
	const values = new Set(operations);
	const parentRequired = new Set(Array.isArray(node.required) ? node.required.map(String) : []);

	const readings = new Map<string, Reading>();
	for (const field of keys) {
		const property = properties[field];
		if (field === key || !isNode(property) || typeof property.description !== "string") continue;
		const read = readNotes(property.description, key, values);
		if (!read) continue;
		const allowed = operations.map((operation) => allows(read.rules, operation));
		const required = operations.map(
			(operation, index) =>
				allowed[index] &&
				(parentRequired.has(field) ||
					read.rules.some((rule) =>
						rule.kind === "required"
							? rule.values.includes(operation)
							: rule.kind === "requiredExcept" && !rule.values.includes(operation),
					)),
		);
		readings.set(field, { property, rest: read.rest, allowed, required });
	}
	if (!readings.size) return node;

	const everywhere = (reading: Reading) => reading.allowed.every(Boolean);
	const uniform = (reading: Reading) =>
		everywhere(reading) && reading.required.every((value) => value === reading.required[0]);
	const sharedProperties: Node = {};
	const sharedRequired: string[] = [];
	const varying: [string, Reading][] = [];
	for (const field of keys) {
		if (field === key) continue;
		const reading = readings.get(field);
		if (!reading) {
			sharedProperties[field] = properties[field];
			if (parentRequired.has(field)) sharedRequired.push(field);
			continue;
		}
		if (uniform(reading)) {
			sharedProperties[field] = stripped(reading.property, reading.rest);
			if (reading.required[0]) sharedRequired.push(field);
			continue;
		}
		varying.push([field, reading]);
		if (everywhere(reading)) sharedProperties[field] = stripped(reading.property, reading.rest);
	}

	// Operations that allow the same fields share one variant. When they differ only in which of those fields they
	// require and the variant has fields of its own, it lists them once and a nested union of the discriminator values
	// restates the required ones; otherwise each requirement set is a variant.
	const groups = new Map<string, number[]>();
	operations.forEach((_operation, index) => {
		const signature = varying.map(([field, reading]) => (reading.allowed[index] ? field : "")).join("|");
		groups.set(signature, [...(groups.get(signature) ?? []), index]);
	});
	const { description, default: fallback, enum: _enum, ...discriminatorRest } = discriminator;
	const discriminatorOf = (names: string[], order: number): Node => ({
		...(order === 0 ? { ...discriminatorRest, ...(description === undefined ? {} : { description }) } : {}),
		...(typeof fallback === "string" && names.includes(fallback) ? { default: fallback } : {}),
		enum: names,
	});
	interface Variant {
		indexes: number[];
		/** The operations of each requirement set, when the variant states the sets as a nested union. */
		nested?: number[][];
	}
	const units: Variant[] = [];
	for (const indexes of groups.values()) {
		const bySignature = new Map<string, number[]>();
		for (const index of indexes) {
			const signature = varying.map(([, reading]) => (reading.required[index] ? "r" : "o")).join("");
			bySignature.set(signature, [...(bySignature.get(signature) ?? []), index]);
		}
		const sets = [...bySignature.values()];
		const ownFields = varying.some(([, reading]) => reading.allowed[indexes[0]] && !everywhere(reading));
		if (sets.length > 1 && ownFields) units.push({ indexes, nested: sets });
		else for (const set of sets) units.push({ indexes: set });
	}
	const variants = units.map(({ indexes, nested }, order) => {
		const at = indexes[0];
		const own: Node = {
			[key]: discriminatorOf(
				indexes.map((index) => operations[index]),
				order,
			),
		};
		const required: string[] = parentRequired.has(key) ? [key] : [];
		if (!nested) {
			for (const [field, reading] of varying) {
				if (!reading.allowed[at]) continue;
				own[field] = everywhere(reading) ? {} : stripped(reading.property, reading.rest);
				if (reading.required[at]) required.push(field);
			}
			return { type: "object", properties: own, required };
		}
		for (const [field, reading] of varying)
			if (reading.allowed[at] && !everywhere(reading)) own[field] = stripped(reading.property, reading.rest);
		const anyOf = nested.map((members) => {
			const properties: Node = { [key]: { enum: members.map((index) => operations[index]) } };
			const needs = parentRequired.has(key) ? [key] : [];
			for (const [field, reading] of varying)
				if (reading.required[members[0]]) {
					properties[field] = {};
					needs.push(field);
				}
			return { type: "object", properties, required: needs };
		});
		return { type: "object", properties: own, required, anyOf };
	});
	return {
		...node,
		properties: sharedProperties,
		required: sharedRequired,
		anyOf: variants,
	};
}

const cache = new WeakMap<object, JsonSchema>();

/** `schema` with every flat object whose fields carry readable applicability notes rebuilt as shared fields plus variants. */
export function structureApplicability(schema: JsonSchema): JsonSchema {
	if (!isNode(schema)) return schema;
	const known = cache.get(schema);
	if (known) return known;
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (!isNode(value)) return value;
		const copy: Node = {};
		for (const [name, child] of Object.entries(value)) copy[name] = walk(child);
		return copy.type === "object" ? restructure(copy) : copy;
	};
	const result = walk(schema) as JsonSchema;
	cache.set(schema, result);
	return result;
}
