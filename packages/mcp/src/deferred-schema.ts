/**
 * The input schema behind a deferred declaration. A deferred tool is declared with thin parameters (field names and
 * JSON types), and its full schema reaches the model only as a tool result: in a refused call, or when the agent asks
 * for it. A compaction summarizes those results away, so the host sends the schemas of the deferred tools the session
 * called again after it (`restoreDeferredSchemas` in the coding agent). The schema is kept beside the declared
 * parameters object itself, so it is found from what a session declares and is never sent to a provider.
 */

const inputSchemas = new WeakMap<object, unknown>();

/** `declared` (a deferred tool's thin parameters) as its own object, remembering the schema calls are checked against. */
export function deferredParameters<T extends object>(declared: T, inputSchema: unknown): T {
	const own = { ...declared };
	inputSchemas.set(own, inputSchema);
	return own;
}

/** The input schema of a deferred declaration, given its declared parameters; undefined for any other declaration. */
export function deferredInputSchema(declared: unknown): unknown {
	return typeof declared === "object" && declared !== null ? inputSchemas.get(declared) : undefined;
}
