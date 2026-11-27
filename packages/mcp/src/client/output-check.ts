import { fromJsonSchema } from "@modelcontextprotocol/client";

/**
 * A checker of a tool's `structuredContent` against the `outputSchema` the server declared in `tools/list`: it returns the
 * first mismatch (`data/hits must be number`), or undefined when the content matches. The schema is compiled on first use
 * and kept for the checker's life, so a new tool list needs a new checker. A schema that cannot be compiled is reported as
 * the mismatch, never skipped.
 */
export function createOutputChecker(
	outputSchema: Record<string, unknown>,
): (structured: unknown) => string | undefined {
	let compiled: ReturnType<typeof fromJsonSchema> | { failure: string } | undefined;
	return (structured) => {
		try {
			compiled ??= fromJsonSchema(outputSchema);
		} catch (error) {
			compiled = {
				failure: `outputSchema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if ("failure" in compiled) return compiled.failure;
		const verdict = compiled["~standard"].validate(structured);
		if (verdict instanceof Promise) throw new Error("MCP output validation is synchronous");
		return verdict.issues ? firstMismatch(verdict.issues[0]?.message) : undefined;
	};
}

/** Ajv joins every error with ", data…"; the first one names the path. */
function firstMismatch(message: string | undefined): string {
	return (message ?? "does not match").split(/, (?=data[/\s])/)[0] ?? "";
}
