import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StructuredResultV1 = {
	version: 1;
	schemaHash: string;
	status: "valid" | "invalid" | "unavailable";
	data?: JsonValue;
	error?: { code: string; path?: string };
	/** A valid answer's report trailer (`Noticed:`, `For coordinator:`, `Ask user:` sections after the block), kept for the caller. */
	notes?: string;
};
export interface ResultContract {
	readonly schema: Readonly<Record<string, unknown>>;
	readonly hash: string;
}

const SCHEMA_BYTES = 16 * 1024;
const RESULT_BYTES = 64 * 1024;
const ENVELOPE_BYTES = 96 * 1024;
const NOTES_CHARS = 2000;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function plain(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}

/** Copy only JSON data, rejecting accessors, cycles, prototype-sensitive keys and excessive values. */
function copyJson(input: unknown, limits: { bytes: number; depth: number; nodes: number }): JsonValue {
	const seen = new WeakSet<object>();
	let nodes = 0;
	const walk = (value: unknown, depth: number): JsonValue => {
		if (++nodes > limits.nodes || depth > limits.depth)
			throw new Error("Result schema or data exceeds its complexity limit");
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "object" || value === null || (!Array.isArray(value) && !plain(value)))
			throw new Error("Result schema or data must be JSON");
		if (seen.has(value)) throw new Error("Result schema or data contains a cycle or shared object");
		seen.add(value);
		if (Array.isArray(value)) {
			if (value.length > limits.nodes) throw new Error("Result schema or data array is too large");
			return Array.from({ length: value.length }, (_, index) => {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (!descriptor || !Object.hasOwn(descriptor, "value"))
					throw new Error("Sparse or accessor arrays are not JSON");
				return walk(descriptor.value, depth + 1);
			});
		}
		const output: Record<string, JsonValue> = Object.create(null);
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (DANGEROUS_KEYS.has(key) || !Object.hasOwn(descriptor, "value"))
				throw new Error("Unsafe result schema or data key");
			output[key] = walk(descriptor.value, depth + 1);
		}
		return output;
	};
	const copied = walk(input, 0);
	if (Buffer.byteLength(JSON.stringify(copied)) > limits.bytes)
		throw new Error("Result schema or data exceeds its byte limit");
	return copied;
}

function checkSchema(
	schema: JsonValue,
	path = "$",
	depth = 0,
	count = { nodes: 0 },
): asserts schema is Record<string, JsonValue> {
	const fail = (message: string) => new Error(`${message} at ${path}`);
	if (!plain(schema) || ++count.nodes > 128 || depth > 8) throw fail("Invalid or excessive result schema");
	for (const key of Object.keys(schema)) if (!KEYS.has(key)) throw fail(`Unsupported result schema keyword: ${key}`);
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (
		types.length < 1 ||
		types.length > 7 ||
		new Set(types).size !== types.length ||
		types.some((t) => typeof t !== "string" || !TYPES.has(t))
	)
		throw fail(
			`Result schema node needs an explicit "type" (${[...TYPES].join("|")}, or an array of them); enum/const do not imply one`,
		);
	if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 1024))
		throw fail("Invalid result schema description");
	const properties = schema.properties;
	if (properties !== undefined) {
		if (!types.includes("object") || !plain(properties) || Object.keys(properties).length > 64)
			throw fail("Invalid result schema properties");
		for (const [key, child] of Object.entries(properties)) {
			if (DANGEROUS_KEYS.has(key) || key.length > 128) throw fail("Unsafe result property name");
			checkSchema(child, `${path}.properties.${key}`, depth + 1, count);
		}
	}
	if (
		schema.required !== undefined &&
		(!types.includes("object") ||
			!Array.isArray(schema.required) ||
			schema.required.length > 64 ||
			new Set(schema.required).size !== schema.required.length ||
			schema.required.some((key) => typeof key !== "string" || !plain(properties) || !Object.hasOwn(properties, key)))
	)
		throw fail("Invalid result schema required fields");
	if (
		schema.additionalProperties !== undefined &&
		(!types.includes("object") || typeof schema.additionalProperties !== "boolean")
	)
		throw fail("Invalid additionalProperties");
	if (schema.items !== undefined) {
		if (!types.includes("array")) throw fail("items requires array type");
		checkSchema(schema.items, `${path}.items`, depth + 1, count);
	}
	for (const key of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"] as const) {
		const value = schema[key];
		if (value === undefined) continue;
		const kind =
			(key.startsWith("min") && key !== "minimum") || (key.startsWith("max") && key !== "maximum")
				? key.slice(3)
				: "number";
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			(kind !== "number" && (!Number.isInteger(value) || value < 0)) ||
			(kind === "Items" && !types.includes("array")) ||
			(kind === "Length" && !types.includes("string")) ||
			(kind === "number" && !types.some((type) => type === "number" || type === "integer"))
		)
			throw fail(`Invalid result schema ${key}`);
	}
	for (const [min, max] of [
		["minimum", "maximum"],
		["minItems", "maxItems"],
		["minLength", "maxLength"],
	] as const)
		if (typeof schema[min] === "number" && typeof schema[max] === "number" && schema[min] > schema[max])
			throw fail(`Invalid result schema ${min}/${max}`);
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 64))
		throw fail("Invalid result schema enum");
	if (schema.enum !== undefined && schema.const !== undefined) throw fail("Use either enum or const");
}

function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (plain(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function freezeJson(value: JsonValue): void {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
}

export function admitResultSchema(input: unknown): ResultContract {
	const schema = copyJson(input, { bytes: SCHEMA_BYTES, depth: 16, nodes: 1024 });
	checkSchema(schema);
	freezeJson(schema);
	// TypeBox's Value.Check handles the admitted JSON Schema keywords without coercion.
	const hash = sha256(`octocode-result-schema/v1\n${canonical(schema)}`);
	return Object.freeze({ schema: schema, hash });
}

export const unavailableResult = (contract: ResultContract): StructuredResultV1 => ({
	version: 1,
	schemaHash: contract.hash,
	status: "unavailable",
});
const invalid = (contract: ResultContract, code: string, path?: string): StructuredResultV1 => ({
	version: 1,
	schemaHash: contract.hash,
	status: "invalid",
	error: { code, ...(path ? { path: path.slice(0, 128) } : {}) },
});

const RESULT_LABEL = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?[*_]{0,2}Structured result:?[*_]{0,2}[ \t]*(?=\n)/gi;
const RESULT_MARKER =
	/(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?[*_]{0,2}Structured result:?[*_]{0,2}[ \t]*\n+[ \t]*```(?:json)?[ \t]*\n/gi;

const TRAILER_LABEL = /^[ \t]*(?:[-*][ \t]+)?[*_]{0,2}(?:Noticed|For coordinator|Ask user)[*_]{0,2}:/i;
const CONTINUATION = /^(?:[ \t]+\S|[-*][ \t]|\d+[.)][ \t])/;

/**
 * The report trailer after the block: only the profile's closing sections (`Noticed:`, `For coordinator:`, `Ask user:`),
 * each with its own lines; a blank line then unmarked prose is not one. Undefined when anything else follows.
 */
function reportTrailer(text: string): string | undefined {
	let inSection = false;
	let blank = false;
	for (const line of text.split("\n")) {
		if (!line.trim()) {
			blank = true;
			continue;
		}
		if (TRAILER_LABEL.test(line)) inSection = true;
		else if (!inSection || (blank && !CONTINUATION.test(line))) return undefined;
		blank = false;
	}
	return text.trim();
}

/** Only a single final marked JSON block counts; earlier prose/code examples never become machine data. */
export function validateResultAnswer(answer: string, contract: ResultContract): StructuredResultV1 {
	const labels = [...answer.matchAll(RESULT_LABEL)];
	if (labels.length === 0) return invalid(contract, "missing");
	if (labels.length > 1) return invalid(contract, "duplicate");
	const matches = [...answer.matchAll(RESULT_MARKER)];
	if (matches.length === 0) return invalid(contract, "framing");
	const match = matches[0];
	const body = answer.slice((match.index ?? 0) + match[0].length);
	const closeMatch = /\n[ \t]*```[ \t]*(?=\n|$)/.exec(body);
	if (!closeMatch) return invalid(contract, "framing");
	// The first closing fence ends the block: JSON text cannot hold a raw newline, so no fence line sits inside it. Text
	// after it never becomes data: a report trailer, or stray prose (fenced or not), is kept as notes for the caller
	// instead of failing a complete answer.
	const end = closeMatch.index;
	const closeLen = closeMatch[0].length;
	const after = body.slice(end + closeLen).trim();
	const notes = after ? (reportTrailer(after) ?? after) : undefined;
	const raw = body.slice(0, end);
	if (Buffer.byteLength(raw) > RESULT_BYTES) return invalid(contract, "oversize");
	try {
		const data = copyJson(JSON.parse(raw), { bytes: RESULT_BYTES, depth: 32, nodes: 8192 });
		if (!Value.Check(contract.schema as TSchema, data)) {
			const error = Value.Errors(contract.schema as TSchema, data).at(0);
			return invalid(contract, "schema", error?.instancePath);
		}
		return {
			version: 1,
			schemaHash: contract.hash,
			status: "valid",
			data,
			...(notes ? { notes: notes.slice(0, NOTES_CHARS) } : {}),
		};
	} catch {
		return invalid(contract, "json");
	}
}

/** Reject corrupt or unknown saved metadata; do not revalidate against a newer schema. */
export function validateStoredStructuredResult(value: unknown): StructuredResultV1 {
	const data = copyJson(value, { bytes: ENVELOPE_BYTES, depth: 35, nodes: 8250 });
	if (
		!plain(data) ||
		data.version !== 1 ||
		typeof data.schemaHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(data.schemaHash) ||
		(data.status !== "valid" && data.status !== "invalid" && data.status !== "unavailable")
	)
		throw new Error("Invalid saved structured result");
	const hasData = Object.hasOwn(data, "data");
	if (
		(data.status === "valid") !== hasData ||
		(data.status !== "invalid" && data.error !== undefined) ||
		(data.notes !== undefined &&
			(data.status !== "valid" || typeof data.notes !== "string" || data.notes.length > NOTES_CHARS)) ||
		(data.status === "invalid" &&
			(!plain(data.error) ||
				typeof data.error.code !== "string" ||
				!/^[a-z]{1,64}$/.test(data.error.code) ||
				Object.keys(data.error).some((key) => key !== "code" && key !== "path") ||
				(data.error.path !== undefined && (typeof data.error.path !== "string" || data.error.path.length > 128)))) ||
		Object.keys(data).some((key) => !["version", "schemaHash", "status", "data", "error", "notes"].includes(key))
	)
		throw new Error("Invalid saved structured result");
	if (hasData) copyJson(data.data, { bytes: RESULT_BYTES, depth: 32, nodes: 8192 });
	return data as unknown as StructuredResultV1;
}
