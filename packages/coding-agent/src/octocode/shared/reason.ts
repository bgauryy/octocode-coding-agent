import { type TSchema, Type } from "typebox";
import { isRecord } from "../../utils/guards.ts";

/**
 * The `reason` argument every native tool call carries: the goal the call serves, in the model's words. The registry
 * wrapper adds it to each native tool's parameters (`withReason`) and removes it before the tool runs (`withoutReason`);
 * permission requests and tool rows read it from the call's input (`callReason`).
 */
export const REASON_DESCRIPTION = "Why you are making this call: the goal it serves, in one short sentence";

const reasonSchema = () => Type.String({ description: REASON_DESCRIPTION });

/** The arguments' `reason`, trimmed, when it is non-empty text. */
export function callReason(input: unknown): string | undefined {
	if (!isRecord(input) || typeof input.reason !== "string") return undefined;
	return input.reason.trim() || undefined;
}

/**
 * The parameters with a required `reason` added. A tool that declares `reason` itself keeps its own definition, and
 * parameters that are not an object schema (no `properties`) are returned unchanged.
 */
export function withReason<T extends TSchema>(parameters: T): T {
	const schema = parameters as unknown as { properties?: Record<string, unknown>; required?: string[] };
	if (!isRecord(schema.properties) || "reason" in schema.properties) return parameters;
	return {
		...parameters,
		properties: { ...schema.properties, reason: reasonSchema() },
		required: [...(schema.required ?? []), "reason"],
	};
}

/** The arguments without `reason`, for a tool that does not declare it. */
export function withoutReason<T>(params: T): T {
	if (!isRecord(params) || !("reason" in params)) return params;
	const { reason: _reason, ...rest } = params;
	return rest as T;
}
