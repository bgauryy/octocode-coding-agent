import { type TSchema, Type } from "typebox";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The `reason` argument every native tool call carries: the goal the call serves, in the model's words. The registry
 * wrapper adds it to each native tool's parameters (`withReason`) and removes it before the tool runs (`withoutReason`);
 * permission requests and tool rows read it from the call's input (`callReason`).
 */
const REASON_DESCRIPTION = "This call's goal, one sentence";

/** The shared `reason` definition; a tool that declares `reason` itself (to read it in `execute`) uses this one. */
export const reasonSchema = () => Type.String({ description: REASON_DESCRIPTION });

/** The arguments' `reason`, trimmed, when it is non-empty text. */
export function callReason(input: unknown): string | undefined {
	if (!isRecord(input) || typeof input.reason !== "string") return undefined;
	return input.reason.trim() || undefined;
}

/**
 * The parameters with a required `reason` added. A tool that declares `reason` itself keeps its own definition.
 * Object-root alternatives get one definition at the root (required there) and an unconstrained `reason` slot in each
 * closed branch, so the model reads the description once and every projection (lifted or composed) still requires it;
 * parameters without object properties are unchanged.
 */
export function withReason<T extends TSchema>(parameters: T): T {
	const schema = parameters as unknown as {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
		anyOf?: TSchema[];
	};
	if (
		schema.type === "object" &&
		!schema.properties &&
		Array.isArray(schema.anyOf) &&
		schema.anyOf.length > 0 &&
		schema.anyOf.every((branch) => isRecord(branch) && isRecord(branch.properties) && !("reason" in branch.properties))
	) {
		return {
			...parameters,
			properties: { reason: reasonSchema() },
			required: [...(schema.required ?? []), "reason"],
			anyOf: schema.anyOf.map((branch) => ({
				...branch,
				properties: { ...(branch as { properties: Record<string, unknown> }).properties, reason: {} },
			})),
		};
	}
	if (!isRecord(schema.properties) || "reason" in schema.properties) return parameters;
	return {
		...parameters,
		properties: { ...schema.properties, reason: reasonSchema() },
		required: [...(schema.required ?? []), "reason"],
	};
}

/** The arguments without `reason`, for a tool that does not declare it. Top level only: nested per-query `reason` fields are the tool's own input, unlike the identity key in `loop-guard.ts`. */
export function withoutReason<T>(params: T): T {
	if (!isRecord(params) || !("reason" in params)) return params;
	const { reason: _reason, ...rest } = params;
	return rest as T;
}
