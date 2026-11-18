import { type TSchema, Type } from "typebox";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { toolHint } from "../../utils/tool-hint.ts";

/**
 * The `reason` argument every native tool call carries: why the call is made, in the model's words. It is the first
 * property of each native tool's declared schema and stays in `required` so the model sees it is expected
 * (`withReason`), but the call never fails for it: before validation `settleReason` fills a missing or empty one, from
 * a nested value the model wrote, else from the call's arguments (`derivedReason`). The registry wrapper removes it
 * before a tool that does not declare it runs (`withoutReason`); permission requests and tool rows read it from the
 * call's input (`callReason`). The schema carries no description: the policy says once what to write
 * (`native/prompts/shared/mcp-fields.md`, `native/prompts/lean/lean.md`), instead of every tool repeating it.
 */

/** The shared `reason` definition; a tool that declares `reason` itself (to read it in `execute`) uses this one. */
export const reasonSchema = () => Type.String();

type SchemaShape = {
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
	items?: TSchema;
};

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The first direct object argument or object array item's non-empty text reason, in argument order. */
function nestedReason(input: Record<string, unknown>): string | undefined {
	for (const value of Object.values(input)) {
		if (isRecord(value) && filled(value.reason)) return value.reason;
		if (!Array.isArray(value)) continue;
		for (const item of value) if (isRecord(item) && filled(item.reason)) return item.reason;
	}
	return undefined;
}

/**
 * The arguments' `reason`, trimmed, when it is non-empty text. A top-level value wins; otherwise the first nested
 * value is the call's reason too, including on the raw call before argument preparation lifts it.
 */
export function callReason(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	const reason = "reason" in input ? input.reason : nestedReason(input);
	return typeof reason === "string" ? reason.trim() || undefined : undefined;
}

/** Whether the tool declared its own top-level `reason`, which its `execute` retains. */
export function declaresReason(parameters: TSchema): boolean {
	const properties = (parameters as unknown as SchemaShape).properties;
	return isRecord(properties) && "reason" in properties;
}

/**
 * The parameters with `reason` first and required. A tool that declares `reason` itself keeps its own definition,
 * moved first. Parameters without object properties are unchanged, and so are parameters that already start with a
 * required `reason`.
 */
export function withReason<T extends TSchema>(parameters: T): T {
	const schema = parameters as unknown as SchemaShape;
	const properties = schema.properties;
	if (!isRecord(properties)) return parameters;
	const required = schema.required ?? [];
	if (Object.keys(properties)[0] === "reason" && required.includes("reason")) return parameters;
	const { reason: declared, ...others } = properties;
	return {
		...parameters,
		properties: { reason: declared ?? reasonSchema(), ...others },
		required: required.includes("reason") ? required : [...required, "reason"],
	};
}

/** `value` without a nested `reason` the `declared` schema has no slot for: a direct object argument or an array's object items. */
function withoutUndeclaredNested(value: unknown, declared: TSchema): unknown {
	const schema = declared as unknown as SchemaShape;
	if (schema.type === "object" && isRecord(schema.properties) && !("reason" in schema.properties)) {
		return isRecord(value) && "reason" in value ? withoutReason(value) : value;
	}
	const itemSchema = schema.items;
	if (schema.type === "array" && itemSchema && Array.isArray(value)) {
		const items = value.map((item) => withoutUndeclaredNested(item, itemSchema));
		return items.some((item, index) => item !== value[index]) ? items : value;
	}
	return value;
}

/**
 * What a call with no stated reason says it is for: the tool name and the most telling argument (`toolHint`, from the
 * first `queries` item when the call has none of its own), else the tool name alone. Never empty.
 */
export function derivedReason(toolName: string, input: unknown): string {
	const queries = isRecord(input) && Array.isArray(input.queries) ? input.queries[0] : undefined;
	const hint = toolHint(input) || toolHint(queries);
	return hint ? `${toolName} ${hint}` : toolName;
}

/** Whether `input`'s reason is the one `derivedReason` makes from the rest of the arguments, not words the model wrote. */
export function hasDerivedReason(toolName: string, input: unknown): boolean {
	return isRecord(input) && filled(input.reason) && input.reason === derivedReason(toolName, withoutReason(input));
}

/** `<parameter name="x">value` runs, as a model writes them when its call's parameters land in text. */
const PARAMETER_TEXT = /<parameter name="([^"]+)">([\s\S]*?)(?=<parameter name="|<\/parameter>|$)/g;

/** `text` as the declared type: numbers, integers and booleans by `type`, objects and arrays by JSON; `undefined` when it does not parse. */
function parameterValue(text: string, property: unknown): unknown {
	const type = isRecord(property) ? property.type : undefined;
	if (type === "number" || type === "integer") {
		const value = Number(text);
		return text !== "" && Number.isFinite(value) && (type === "number" || Number.isInteger(value)) ? value : undefined;
	}
	if (type === "boolean") return text === "true" ? true : text === "false" ? false : undefined;
	if (type === "object" || type === "array") {
		try {
			const value: unknown = JSON.parse(text);
			return type === "array" ? (Array.isArray(value) ? value : undefined) : isRecord(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}
	return text;
}

/**
 * The arguments with `<parameter name="x">value` text written inside a top-level `reason` lifted into the declared,
 * absent top-level properties it names, and the reason cut before the first `</reason>` or `<parameter`. Unchanged
 * when nothing is lifted: a set or undeclared name, or a value that does not fit its declared type, stays as written.
 */
function withLiftedParameters(
	params: Record<string, unknown>,
	properties: Record<string, unknown>,
): Record<string, unknown> {
	const reason = params.reason;
	if (typeof reason !== "string" || !reason.includes("<parameter name=")) return params;
	const lifted: Record<string, unknown> = {};
	for (const [, name, text] of reason.matchAll(PARAMETER_TEXT)) {
		if (!(name in properties) || params[name] !== undefined || name in lifted) continue;
		const value = parameterValue(text.trim(), properties[name]);
		if (value !== undefined) lifted[name] = value;
	}
	if (Object.keys(lifted).length === 0) return params;
	const cut = reason.search(/<\/reason>|<parameter/);
	return { ...params, ...lifted, reason: reason.slice(0, cut).trim() };
}

/**
 * The call's arguments with the reason settled before validation, so a call never fails for it. A top-level non-empty
 * text wins, after `<parameter>` text written inside it is lifted. Else the first nested one is lifted, else `derivedReason` fills it. A nested `reason` the model wrote
 * where `declared` has no slot is removed: it is not the tool's input and would fail strict arguments. Parameters
 * without object properties are returned unchanged.
 */
export function settleReason<T>(params: T, toolName: string, declared: TSchema): T {
	const shape = declared as unknown as SchemaShape;
	if (!isRecord(params) || !isRecord(shape.properties)) return params;
	const args = withLiftedParameters(params, shape.properties);
	const changes: Record<string, unknown> = {};
	for (const [name, property] of Object.entries(shape.properties)) {
		if (name === "reason" || !(name in args)) continue;
		const value = withoutUndeclaredNested(args[name], property as TSchema);
		if (value !== args[name]) changes[name] = value;
	}
	const cleaned = Object.keys(changes).length > 0 ? { ...args, ...changes } : args;
	if (filled(args.reason)) return cleaned as T;
	return { ...cleaned, reason: nestedReason(args) ?? derivedReason(toolName, cleaned) } as T;
}

/** The arguments without `reason`, for a tool that does not declare it. Top level only: nested per-query `reason` fields are the tool's own input, unlike the identity key in `loop-guard.ts`. */
export function withoutReason<T>(params: T): T {
	if (!isRecord(params) || !("reason" in params)) return params;
	const { reason: _reason, ...rest } = params;
	return rest as T;
}

/** Fewest words a model-given reason needs to say anything the row's title does not (`Edit` alone does not; `Run tests` does). */
const REASON_MIN_WORDS = 2;

/** Whether a call's `reason` carries information worth a `↳` line. */
export function isInformativeReason(reason: string | undefined): reason is string {
	return reason !== undefined && reason.trim().split(/\s+/).length >= REASON_MIN_WORDS;
}
