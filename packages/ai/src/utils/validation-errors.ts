import type { TLocalizedValidationError } from "typebox/error";
import { describeReceivedArguments } from "./json-parse.ts";

/** Dotted path of a schema validation error, naming the missing property for `required`; "root" for the whole value. */
export function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

type ValidationError = TLocalizedValidationError;

const UNION_KEYWORDS = new Set(["anyOf", "oneOf"]);

function isUnion(error: ValidationError): boolean {
	return UNION_KEYWORDS.has(error.keyword);
}

/** The values a `const` or `enum` error allows, or undefined for other errors. */
function allowedValues(error: ValidationError): unknown[] | undefined {
	const params = error.params as { allowedValue?: unknown; allowedValues?: unknown[] };
	if (error.keyword === "const" && "allowedValue" in params) return [params.allowedValue];
	if (error.keyword === "enum" && Array.isArray(params.allowedValues)) return params.allowedValues;
	return undefined;
}

function formatAllowed(values: unknown[]): string {
	const unique = [...new Set(values.map((value) => JSON.stringify(value)))];
	return unique.length === 1 ? `expected ${unique[0]}` : `expected one of ${unique.join(", ")}`;
}

function describeError(error: ValidationError): string {
	const path = formatValidationPath(error);
	const allowed = allowedValues(error);
	if (allowed) return `${path}: ${formatAllowed(allowed)}`;
	if (error.keyword === "additionalProperties") {
		const names = (error.params as { additionalProperties?: string[] }).additionalProperties;
		if (names?.length)
			return `${path}: unexpected ${names.length === 1 ? "property" : "properties"} ${names.join(", ")}`;
	}
	return `${path}: ${error.message}`;
}

/** Errors of each alternative of a union error, keyed by alternative index. */
function alternativesOf(union: ValidationError, errors: ValidationError[]): Map<number, ValidationError[]> {
	const prefix = `${union.schemaPath}/${union.keyword}/`;
	const byAlternative = new Map<number, ValidationError[]>();
	for (const error of errors) {
		if (!error.schemaPath.startsWith(prefix) || error.instancePath.length < union.instancePath.length) continue;
		const index = Number.parseInt(error.schemaPath.slice(prefix.length), 10);
		if (Number.isNaN(index)) continue;
		byAlternative.set(index, [...(byAlternative.get(index) ?? []), error]);
	}
	return byAlternative;
}

/**
 * Lines for one union error: when every alternative fails on the same literal value, the values
 * allowed; otherwise the errors of the alternative the value came closest to (the discriminator
 * matched, then the fewest errors).
 */
function summarizeUnion(union: ValidationError, errors: ValidationError[]): string[] {
	const alternatives = [...alternativesOf(union, errors).values()];
	if (alternatives.length === 0) return [describeError(union)];
	const literalErrors = alternatives.map((errs) => errs.find((error) => allowedValues(error)));
	const [first] = literalErrors;
	if (first && literalErrors.every((error) => error?.instancePath === first.instancePath)) {
		// No alternative's discriminator matched: name every value the discriminator may take.
		const values = literalErrors.flatMap((error) => allowedValues(error!)!);
		return [`${formatValidationPath(first)}: ${formatAllowed(values)}`];
	}
	const mismatchedLiterals = (errs: ValidationError[]) => errs.filter((error) => allowedValues(error)).length;
	const best = alternatives.reduce((a, b) =>
		mismatchedLiterals(b) < mismatchedLiterals(a) ||
		(mismatchedLiterals(b) === mismatchedLiterals(a) && b.length < a.length)
			? b
			: a,
	);
	return summarizeValidationErrors(best);
}

/** Readable lines for validation errors: failing paths with allowed values, without per-alternative union noise. */
function summarizeValidationErrors(errors: ValidationError[]): string[] {
	const consumed = new Set<ValidationError>();
	const unions = errors.filter(isUnion).sort((a, b) => a.schemaPath.length - b.schemaPath.length);
	const replacement = new Map<ValidationError, string[]>();
	for (const union of unions) {
		if (consumed.has(union)) continue;
		const prefix = `${union.schemaPath}/${union.keyword}/`;
		for (const error of errors) if (error.schemaPath.startsWith(prefix)) consumed.add(error);
		replacement.set(union, summarizeUnion(union, errors));
	}
	const lines: string[] = [];
	const literalLines = new Map<string, { index: number; values: unknown[]; path: string }>();
	for (const error of errors) {
		if (consumed.has(error) || error.keyword === "boolean") continue;
		const values = allowedValues(error);
		if (values) {
			// Alternatives of a union the error list did not report as a whole: merge their literals per path.
			const entry = literalLines.get(error.instancePath);
			if (entry) entry.values.push(...values);
			else {
				literalLines.set(error.instancePath, {
					index: lines.length,
					values: [...values],
					path: formatValidationPath(error),
				});
				lines.push("");
			}
			continue;
		}
		lines.push(...(replacement.get(error) ?? [describeError(error)]));
	}
	for (const { index, values, path } of literalLines.values()) lines[index] = `${path}: ${formatAllowed(values)}`;
	return [...new Set(lines)];
}

/** The value at a validation error's instance path, for quoting what was sent. */
function valueAt(args: unknown, instancePath: string): unknown {
	let value = args;
	for (const part of instancePath.split("/").slice(1)) value = (value as Record<string, unknown> | undefined)?.[part];
	return value;
}

/**
 * A field sent inside a nested object when the input takes it at the top level (a `cursor` inside `queries`): the
 * correct form, ahead of the required-property errors the misplaced object also raises.
 */
function misplacedFieldLines(errors: ValidationError[], schema: unknown, args: unknown): string[] {
	const accepted = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
	const lines: string[] = [];
	for (const error of errors) {
		if (error.keyword !== "additionalProperties" || !error.instancePath) continue;
		const names = (error.params as { additionalProperties?: string[] }).additionalProperties ?? [];
		for (const name of names) {
			if (!Object.hasOwn(accepted, name)) continue;
			const path = formatValidationPath(error);
			const value = JSON.stringify((valueAt(args, error.instancePath) as Record<string, unknown>)?.[name]) ?? "";
			// The arguments are echoed below, capped: a value too long to retype is only named here.
			const form = value.length > 500 ? `"${name}"` : `{"${name}":${value}}`;
			lines.push(`${path}.${name}: goes at the top level of the input, not inside ${path}: ${form}`);
		}
	}
	return [...new Set(lines)];
}

/** Message body for a failed validation: the problems, then a capped echo of the arguments. */
export function formatValidationFailure(
	toolName: string,
	errors: ValidationError[],
	args: unknown,
	schema?: unknown,
): string {
	const lines = [...misplacedFieldLines(errors, schema, args), ...summarizeValidationErrors(errors)].map(
		(line) => `  - ${line}`,
	);
	const problems = lines.join("\n") || "Unknown validation error";
	const received = describeReceivedArguments(JSON.stringify(args) ?? "undefined");
	return `Validation failed for tool "${toolName}":\n${problems}\n\n${received}`;
}

/** The top-level properties the problems sit at or under; an unexpected root property counts by its own name. */
export function failingProperties(errors: ValidationError[]): string[] {
	const names = new Set<string>();
	for (const error of errors) {
		const [, top] = error.instancePath.split("/");
		if (top) names.add(top);
		else
			for (const name of (error.params as { additionalProperties?: string[] }).additionalProperties ?? [])
				names.add(name);
	}
	return [...names];
}
