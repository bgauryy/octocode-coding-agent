import { type TSchema, Type } from "typebox";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The `reason` argument every native tool call carries: why the call is made, in the model's words. The registry
 * wrapper adds it to each native tool's parameters (`withReason`) and removes it before the tool runs (`withoutReason`);
 * permission requests and tool rows read it from the call's input (`callReason`).
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

/** The first direct object argument or object array item's text reason, in argument order. */
function nestedReason(input: Record<string, unknown>): string | undefined {
	for (const value of Object.values(input)) {
		if (isRecord(value) && typeof value.reason === "string") return value.reason;
		if (!Array.isArray(value)) continue;
		for (const item of value) if (isRecord(item) && typeof item.reason === "string") return item.reason;
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

/** Add an optional call-reason slot to a direct object argument or to an array's object items. */
function withNestedReason(property: TSchema): TSchema {
	const schema = property as unknown as SchemaShape;
	if (schema.type === "object" && isRecord(schema.properties) && !("reason" in schema.properties)) {
		return {
			...property,
			// No description: the required top-level `reason` is the one the model reads; this slot only lets `liftNestedReason` accept a value it wrote here.
			properties: { ...schema.properties, reason: Type.Optional(Type.String()) },
		};
	}
	if (schema.type === "array" && schema.items) {
		const items = withNestedReason(schema.items);
		return items === schema.items ? property : { ...property, items };
	}
	return property;
}

function withNestedReasons(properties: Record<string, unknown>): Record<string, unknown> {
	let changed = false;
	const mapped = Object.fromEntries(
		Object.entries(properties).map(([name, property]) => {
			const nested = withNestedReason(property as TSchema);
			changed ||= nested !== property;
			return [name, nested];
		}),
	);
	return changed ? mapped : properties;
}

/** Whether the tool declared its own top-level `reason`, which its `execute` retains. */
export function declaresReason(parameters: TSchema): boolean {
	const properties = (parameters as unknown as SchemaShape).properties;
	return isRecord(properties) && "reason" in properties;
}

/**
 * The parameters with a required `reason` added. A tool that declares `reason` itself keeps its own definition.
 * Direct object arguments and object array items also accept an optional `reason`; `liftNestedReason` copies the first
 * one to the required top level before validation. Parameters without object properties are unchanged.
 */
export function withReason<T extends TSchema>(parameters: T): T {
	const schema = parameters as unknown as SchemaShape;
	if (!isRecord(schema.properties)) return parameters;
	const properties = withNestedReasons(schema.properties);
	if ("reason" in schema.properties) {
		return properties === schema.properties ? parameters : { ...parameters, properties };
	}
	return {
		...parameters,
		properties: { ...properties, reason: reasonSchema() },
		required: [...(schema.required ?? []), "reason"],
	};
}

/**
 * Copy the first nested reason to the top level when that property is absent. The top level wins; nested values stay
 * in place because they can also be meaningful per-item arguments (for example a file change or coordinate lock).
 */
export function liftNestedReason<T>(params: T): T {
	if (!isRecord(params) || "reason" in params) return params;
	const reason = nestedReason(params);
	return reason === undefined ? params : { ...params, reason };
}

/** The arguments without `reason`, for a tool that does not declare it. Top level only: nested per-query `reason` fields are the tool's own input, unlike the identity key in `loop-guard.ts`. */
export function withoutReason<T>(params: T): T {
	if (!isRecord(params) || !("reason" in params)) return params;
	const { reason: _reason, ...rest } = params;
	return rest as T;
}
