import { isNode, type Node } from "./schema-nodes.ts";
import type { JsonSchema } from "./types.ts";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";

/**
 * Servers that describe one flat object for several operations state, in each field's description, when the field
 * applies ("Only with operation: a, b.", "Not with operation: c.", "Required with operation: a.", "Required except with
 * operation: c."). Repeated per field that is a lot of prose; this pre-pass reads the notes and rebuilds the schema as the
 * shared fields plus one variant per operation group, which `schemaToTs` renders as `Shared & ({ operation: "a"; ... } | ...)`.
 * Fields that share a rule may state it once, in the object's own description ("For a, b: required except with
 * operation: c."): that reads as the same note on each field it names, so a field the rule requires reads as required
 * where it is, not as optional with the rule in a comment. A field whose notes cannot be read keeps its text, a note of
 * the object that cannot be read stays on the object, and an object without readable notes is left as it is.
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

interface ObjectNote {
	/** The note as the object's description writes it. */
	text: string;
	fields: string[];
	/** The note as a field's description would write it (`NOTE_KINDS`). */
	fieldNote: string;
	key: string;
	values: string[];
}

const OBJECT_NOTE =
	/(?:^|\s)For ([\w$-]+(?:, [\w$-]+)*): (only with|not with|required with|required except with) ([\w$-]+): ([\w$-]+(?:, [\w$-]+)*)\./g;

const REQUIRED_NOTE = /Required (?:except )?with [\w$-]+: [\w$-]+(?:, [\w$-]+)*\./;

/** The notes of an object's description about its own fields. */
function objectNotes(node: Node, properties: Node): ObjectNote[] {
	if (typeof node.description !== "string") return [];
	return [...node.description.matchAll(OBJECT_NOTE)].flatMap(([text, list, kind, key, values]) => {
		const fields = list.split(", ");
		if (!fields.every((field) => field !== key && isNode(properties[field]))) return [];
		const fieldNote = `${kind[0].toUpperCase()}${kind.slice(1)} ${key}: ${values}.`;
		return [{ text, fields, fieldNote, key, values: values.split(", ") }];
	});
}

/** `properties` with each of `notes` written on the fields it names. */
function withFieldNotes(properties: Node, notes: readonly ObjectNote[]): Node {
	const result = { ...properties };
	for (const { fields, fieldNote } of notes)
		for (const field of fields) {
			const property = result[field] as Node;
			const description = typeof property.description === "string" ? `${property.description} ` : "";
			result[field] = { ...property, description: `${description}${fieldNote}` };
		}
	return result;
}

/**
 * Fields a description says some value of another field requires ("Required with operation: a." on the field, "For a,
 * b: required except with operation: c." on its object), each with the note that says so.
 */
export function conditionallyRequired(schema: unknown, seen = new Set<unknown>()): { field: string; note: string }[] {
	if (typeof schema !== "object" || schema === null || seen.has(schema)) return [];
	seen.add(schema);
	if (Array.isArray(schema)) return schema.flatMap((item) => conditionallyRequired(item, seen));
	const node = schema as Node;
	const properties = isNode(node.properties) ? node.properties : {};
	const found = objectNotes(node, properties)
		.filter((note) => note.fieldNote.startsWith("Required"))
		.flatMap(({ fields, text }) => fields.map((field) => ({ field, note: text.trim() })));
	for (const [field, property] of Object.entries(properties)) {
		const description = isNode(property) ? property.description : undefined;
		const note = typeof description === "string" ? REQUIRED_NOTE.exec(description)?.[0] : undefined;
		if (note) found.push({ field, note });
	}
	return [...found, ...Object.values(node).flatMap((value) => conditionallyRequired(value, seen))];
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

/**
 * Whether a field with these rules exists on `operation`. A field whose only rule is "Required with" exists only where
 * it is required: the Octocode server refuses `number` on a `commit` and `keywords` on a `resolve`, and states a field
 * that is also optional elsewhere with a second rule (`repo`: "Not with operation: list. Required with operation: get.").
 * Reading it the other way would offer the model a call the server refuses; this way it can only leave out a field.
 */
const allows = (rules: readonly Rule[], operation: string) =>
	rules.every((rule) => rule.kind === "required") && rules.length > 0
		? rules.some((rule) => rule.values.includes(operation))
		: rules.every((rule) =>
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
	const stated = node.properties;
	const keys = Object.keys(stated);
	const notes = objectNotes(node, stated);
	let key: string | undefined;
	let most = 0;
	for (const candidate of keys) {
		if (!stringEnum(stated[candidate])) continue;
		const count = keys.filter(
			(other) =>
				other !== candidate &&
				(mentions(stated[other], candidate) ||
					notes.some((note) => note.key === candidate && note.fields.includes(other))),
		).length;
		if (count > most) {
			most = count;
			key = candidate;
		}
	}
	if (key === undefined) return node;
	const discriminator = stated[key] as Node;
	const operations = stringEnum(discriminator) as string[];
	const values = new Set(operations);
	const moved = notes.filter((note) => note.key === key && note.values.every((value) => values.has(value)));
	const properties = withFieldNotes(stated, moved);
	const { description: stating, ...object } = node;
	const description = moved
		.reduce((text, note) => text.replace(note.text, ""), typeof stating === "string" ? stating : "")
		.trim();
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
	const { description: own, default: fallback, enum: _enum, ...discriminatorRest } = discriminator;
	const discriminatorOf = (names: string[], order: number): Node => ({
		...(order === 0 ? { ...discriminatorRest, ...(own === undefined ? {} : { description: own }) } : {}),
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
		...object,
		...(description ? { description } : {}),
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
