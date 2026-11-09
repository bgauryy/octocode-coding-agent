import { type TSchema, Type } from "typebox";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { toolHint } from "../../utils/tool-hint.ts";

/**
 * The `reason` argument every native tool call carries: why the call is made, in the model's words. It is the first
 * property of each native tool's declared schema and stays in `required` so the model sees it is expected
 * (`withReason`), but the call never fails for it: before validation `settleReason` fills a missing or empty one, from
 * a nested value the model wrote, else from the call's arguments (`derivedReason`). The registry wrapper removes it
 * before a tool that does not declare it runs (`withoutReason`); permission requests and tool rows read it from the
 * call's input (`callReason`).
 */
const REASON_DESCRIPTION = "Why this call, one sentence";

/** The shared `reason` definition; a tool that declares `reason` itself (to read it in `execute`) uses this one. */
export const reasonSchema = () => Type.String({ description: REASON_DESCRIPTION });

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

/**
 * The call's arguments with the reason settled before validation, so a call never fails for it. A top-level non-empty
 * text wins. Else the first nested one is lifted, else `derivedReason` fills it. A nested `reason` the model wrote
 * where `declared` has no slot is removed: it is not the tool's input and would fail strict arguments. Parameters
 * without object properties are returned unchanged.
 */
export function settleReason<T>(params: T, toolName: string, declared: TSchema): T {
	const shape = declared as unknown as SchemaShape;
	if (!isRecord(params) || !isRecord(shape.properties)) return params;
	const changes: Record<string, unknown> = {};
	for (const [name, property] of Object.entries(shape.properties)) {
		if (name === "reason" || !(name in params)) continue;
		const value = withoutUndeclaredNested(params[name], property as TSchema);
		if (value !== params[name]) changes[name] = value;
	}
	const cleaned = Object.keys(changes).length > 0 ? { ...params, ...changes } : params;
	if (filled(params.reason)) return cleaned;
	return { ...cleaned, reason: nestedReason(params) ?? derivedReason(toolName, cleaned) };
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
