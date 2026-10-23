import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StructuredResultV1 = {
	version: 1;
	schemaHash: string;
	status: "valid" | "invalid" | "unavailable";
	data?: JsonValue;
	error?: { code: string; path?: string };
};
export interface ResultContract { readonly schema: Readonly<Record<string, unknown>>; readonly hash: string }

const SCHEMA_BYTES = 16 * 1024;
const RESULT_BYTES = 64 * 1024;
const ENVELOPE_BYTES = 96 * 1024;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function plain(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Copy only JSON data, rejecting accessors, cycles, prototype-sensitive keys and excessive values. */
function copyJson(input: unknown, limits: { bytes: number; depth: number; nodes: number }): JsonValue {
	const seen = new WeakSet<object>();
	let nodes = 0;
	const walk = (value: unknown, depth: number): JsonValue => {
		if (++nodes > limits.nodes || depth > limits.depth) throw new Error("Result schema or data exceeds its complexity limit");
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "object" || value === null || (!Array.isArray(value) && !plain(value)))
			throw new Error("Result schema or data must be JSON");
		if (seen.has(value)) throw new Error("Result schema or data contains a cycle or shared object");
		seen.add(value);
		if (Array.isArray(value)) {
			if (value.length > limits.nodes) throw new Error("Result schema or data array is too large");
			return Array.from({ length: value.length }, (_, index) => {
				if (!Object.hasOwn(value, index)) throw new Error("Sparse arrays are not JSON");
				return walk(value[index], depth + 1);
			});
		}
		const output: Record<string, JsonValue> = Object.create(null);
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (DANGEROUS_KEYS.has(key) || !Object.hasOwn(descriptor, "value")) throw new Error("Unsafe result schema or data key");
			output[key] = walk(descriptor.value, depth + 1);
		}
		return output;
	};
	const copied = walk(input, 0);
	if (Buffer.byteLength(JSON.stringify(copied)) > limits.bytes) throw new Error("Result schema or data exceeds its byte limit");
	return copied;
}

function checkSchema(schema: JsonValue, depth = 0, count = { nodes: 0 }): asserts schema is Record<string, JsonValue> {
	if (!plain(schema) || ++count.nodes > 128 || depth > 8) throw new Error("Invalid or excessive result schema");
	for (const key of Object.keys(schema)) if (!KEYS.has(key)) throw new Error(`Unsupported result schema keyword: ${key}`);
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.length < 1 || types.length > 7 || new Set(types).size !== types.length || types.some((t) => typeof t !== "string" || !TYPES.has(t)))
		throw new Error("Result schema needs an explicit supported type");
	if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 1024)) throw new Error("Invalid result schema description");
	const properties = schema.properties;
	if (properties !== undefined) {
		if (!types.includes("object") || !plain(properties) || Object.keys(properties).length > 64) throw new Error("Invalid result schema properties");
		for (const [key, child] of Object.entries(properties)) {
			if (DANGEROUS_KEYS.has(key) || key.length > 128) throw new Error("Unsafe result property name");
			checkSchema(child, depth + 1, count);
		}
	}
	if (schema.required !== undefined && (!types.includes("object") || !Array.isArray(schema.required) || schema.required.length > 64 || new Set(schema.required).size !== schema.required.length || schema.required.some((key) => typeof key !== "string" || !plain(properties) || !Object.hasOwn(properties, key))))
		throw new Error("Invalid result schema required fields");
	if (schema.additionalProperties !== undefined && (!types.includes("object") || typeof schema.additionalProperties !== "boolean")) throw new Error("Invalid additionalProperties");
	if (schema.items !== undefined) {
		if (!types.includes("array")) throw new Error("items requires array type");
		checkSchema(schema.items, depth + 1, count);
	}
	for (const key of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"] as const) {
		const value = schema[key];
		if (value === undefined) continue;
		const kind = key.startsWith("min") && key !== "minimum" || key.startsWith("max") && key !== "maximum" ? key.slice(3) : "number";
		if (typeof value !== "number" || !Number.isFinite(value) || (kind !== "number" && (!Number.isInteger(value) || value < 0)) ||
			(kind === "Items" && !types.includes("array")) || (kind === "Length" && !types.includes("string")) || (kind === "number" && !types.some((type) => type === "number" || type === "integer")))
			throw new Error(`Invalid result schema ${key}`);
	}
	for (const [min, max] of [["minimum", "maximum"], ["minItems", "maxItems"], ["minLength", "maxLength"]] as const)
		if (typeof schema[min] === "number" && typeof schema[max] === "number" && schema[min] > schema[max]) throw new Error(`Invalid result schema ${min}/${max}`);
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 64)) throw new Error("Invalid result schema enum");
	if (schema.enum !== undefined && schema.const !== undefined) throw new Error("Use either enum or const");
}

function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(",")}}`;
	return JSON.stringify(value);
}

export function admitResultSchema(input: unknown): ResultContract {
	const schema = copyJson(input, { bytes: SCHEMA_BYTES, depth: 16, nodes: 1024 });
	checkSchema(schema);
	// TypeBox's Value.Check handles the admitted JSON Schema keywords without coercion.
	const hash = createHash("sha256").update(`octocode-result-schema/v1\n${canonical(schema)}`).digest("hex");
	return { schema: schema as Record<string, unknown>, hash };
}

export const unavailableResult = (contract: ResultContract): StructuredResultV1 => ({ version: 1, schemaHash: contract.hash, status: "unavailable" });
const invalid = (contract: ResultContract, code: string, path?: string): StructuredResultV1 => ({
	version: 1, schemaHash: contract.hash, status: "invalid", error: { code, ...(path ? { path: path.slice(0, 128) } : {}) },
});

/** Only an exact final marked JSON block counts; earlier prose/code examples never become machine data. */
export function validateResultAnswer(answer: string, contract: ResultContract): StructuredResultV1 {
	const marker = "\nStructured result:\n```json\n";
	const first = answer.indexOf(marker);
	if (first < 0) return invalid(contract, "missing");
	if (answer.indexOf("\nStructured result:", first + marker.length) >= 0) return invalid(contract, "duplicate");
	const body = answer.slice(first + marker.length);
	const end = body.lastIndexOf("\n```");
	if (end < 0 || body.slice(end + 4).trim()) return invalid(contract, "framing");
	const raw = body.slice(0, end);
	if (Buffer.byteLength(raw) > RESULT_BYTES) return invalid(contract, "oversize");
	try {
		const data = copyJson(JSON.parse(raw), { bytes: RESULT_BYTES, depth: 32, nodes: 8192 });
		if (!Value.Check(contract.schema as TSchema, data)) {
			const error = Value.Errors(contract.schema as TSchema, data).First();
			return invalid(contract, "schema", error?.instancePath);
		}
		return { version: 1, schemaHash: contract.hash, status: "valid", data };
	} catch {
		return invalid(contract, "json");
	}
}

/** Reject corrupt or unknown saved metadata; do not revalidate against a newer schema. */
export function validateStoredStructuredResult(value: unknown): StructuredResultV1 {
	const data = copyJson(value, { bytes: ENVELOPE_BYTES, depth: 35, nodes: 8250 });
	if (!plain(data) || data.version !== 1 || typeof data.schemaHash !== "string" || !/^[a-f0-9]{64}$/.test(data.schemaHash) ||
		!["valid", "invalid", "unavailable"].includes(String(data.status))) throw new Error("Invalid saved structured result");
	const hasData = Object.hasOwn(data, "data");
	if ((data.status === "valid") !== hasData || (data.status !== "invalid" && data.error !== undefined) ||
		(data.status === "invalid" && (!plain(data.error) || typeof data.error.code !== "string" || data.error.code.length > 64 || (data.error.path !== undefined && (typeof data.error.path !== "string" || data.error.path.length > 128)))) ||
		Object.keys(data).some((key) => !["version", "schemaHash", "status", "data", "error"].includes(key)))
		throw new Error("Invalid saved structured result");
	return data as StructuredResultV1;
}
