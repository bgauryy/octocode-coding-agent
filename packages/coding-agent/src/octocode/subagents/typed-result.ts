import type { StructuredResultV1 } from "./result-schema.ts";

/**
 * What a result-contract run's report says about its typed result: a failure when the child did not report `done` or its
 * answer is not valid, with the reason named: the report status, else the schema error, else that no result was produced.
 * Undefined for a run without a contract or one that reported `done` with a valid result.
 */
export function typedResultFailure(
	resultContract: unknown,
	reported: string | undefined,
	structured: StructuredResultV1 | undefined,
): string | undefined {
	if (!resultContract) return undefined;
	const valid = structured?.status === "valid";
	if (reported === "done" && valid) return undefined;
	const reason = structured?.error?.code ?? structured?.status ?? "unavailable";
	const said = reported ? `the child reported ${reported}, not done` : "the child did not report done";
	return valid
		? `Result not accepted: ${said} (its result is schema-valid).`
		: reported === "done"
			? `Result schema validation: ${reason}.`
			: `Result not accepted: ${said}; schema validation: ${reason}.`;
}
