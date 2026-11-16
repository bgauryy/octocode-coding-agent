import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { queriesCap } from "./validation-hint.ts";

type Schema = Record<string, unknown>;

const MAX_ECHO_CHARS = 1500;

/** The properties a `queries` item of the server's schema declares, from the root or any root alternative. */
function itemProperties(schema: Schema): Set<string> {
	const names = new Set<string>();
	for (const shape of [schema, ...((schema.anyOf ?? schema.oneOf ?? []) as unknown[])]) {
		if (!isRecord(shape) || !isRecord(shape.properties)) continue;
		const queries = shape.properties.queries;
		const items = isRecord(queries) ? queries.items : undefined;
		if (isRecord(items) && isRecord(items.properties)) for (const key of Object.keys(items.properties)) names.add(key);
	}
	return names;
}

/**
 * The call a repeated identical validation failure should have been: root fields the schema does not declare move into
 * each `queries` item that declares them (and are dropped otherwise), and a batch over the server's cap splits into
 * calls of at most the cap. Only the shape the model already sent is rearranged; undefined when the arguments have no
 * `queries` array, when nothing would change, or when the echo is too long to be useful.
 */
export function correctedCalls(schema: Schema, args: unknown, offending: string[]): string | undefined {
	if (!isRecord(args) || !Array.isArray(args.queries)) return undefined;
	const declared = isRecord(schema.properties) ? schema.properties : {};
	const strays = offending.filter((key) => key in args && !(key in declared) && key !== "queries");
	const accepted = itemProperties(schema);
	const moved = strays.filter((key) => accepted.has(key));
	const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !strays.includes(key) && key !== "queries"));
	const queries = args.queries.map((query) =>
		isRecord(query) ? { ...Object.fromEntries(moved.map((key) => [key, args[key]])), ...query } : query,
	);
	const cap = queriesCap(schema);
	const size = cap !== undefined && cap > 0 ? cap : queries.length || 1;
	const calls: Schema[] = [];
	for (let i = 0; i < Math.max(queries.length, 1); i += size)
		calls.push({ ...rest, queries: queries.slice(i, i + size) });
	if (strays.length === 0 && calls.length === 1) return undefined;
	const text = calls.map((call) => JSON.stringify(call)).join("\n");
	if (text.length > MAX_ECHO_CHARS) return undefined;
	return `This failed identically twice. Send ${calls.length === 1 ? "this call" : `these ${calls.length} calls in the same turn`}:\n${text}`;
}
