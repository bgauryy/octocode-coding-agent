import { isRecord } from "../../utils/guards.ts";

/**
 * Repair only Octocode's known query envelope, before schema validation and permission checks. No server call is
 * retried. Ambiguous batches and cursor conflicts remain errors rather than guessing which query should continue.
 */
export function prepareOctocodeArguments(schema: Record<string, unknown>, value: unknown): unknown {
	if (!isRecord(value) || !isRecord(schema.properties)) return value;
	const queriesSchema = schema.properties.queries;
	if (!isRecord(queriesSchema) || queriesSchema.type !== "array") return value;
	let queries: unknown = value.queries;
	if (typeof queries === "string") {
		for (let depth = 0; depth < 2 && typeof queries === "string"; depth++) {
			try {
				queries = JSON.parse(queries);
			} catch {
				break;
			}
		}
		if (!Array.isArray(queries)) throw new Error("repair: queries must be a JSON array, not a string-encoded value.");
	}
	const args = queries === value.queries ? value : { ...value, queries };
	if (!Object.hasOwn(args, "cursor") || Object.hasOwn(schema.properties, "cursor")) return args;
	const item = queriesSchema.items;
	if (!isRecord(item) || !isRecord(item.properties) || !Object.hasOwn(item.properties, "cursor")) return args;
	if (!Array.isArray(queries) || queries.length !== 1 || !isRecord(queries[0]) || Object.hasOwn(queries[0], "cursor")) {
		throw new Error("repair: place cursor inside the single query it continues; remove the root cursor.");
	}
	const { cursor, ...rest } = args;
	return { ...rest, queries: [{ ...queries[0], cursor }] };
}
