import { liftedProperties, resolveLocalRef } from "@octocodeai/octocode-ai/utils/json-schema-shape";

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The objects a root schema accepts: its alternatives (`anyOf`/`oneOf`), or the schema itself. */
const rootShapes = (schema: Schema): Schema[] => {
	const branches = schema.anyOf ?? schema.oneOf;
	return Array.isArray(branches) && branches.length > 0 ? branches.filter(isRecord) : [schema];
};

/** The properties a `queries` item may carry, every item alternative and local `$ref` included; empty when unknown. */
function itemProperties(queries: unknown, root: Schema): Schema {
	if (!isRecord(queries)) return {};
	const items = resolveLocalRef(queries.items, root);
	if (!isRecord(items)) return {};
	// The item is lifted as its own root, so its `$ref`s still resolve against the tool's definitions.
	return liftedProperties({ ...items, $defs: root.$defs, definitions: root.definitions });
}

const ANNOTATIONS = ["reason", "reasoning"] as const;

/**
 * Rewrites the argument shapes models commonly get wrong into the one shape the server's schema accepts, before
 * validation; undefined when no rule can apply to this schema. Each rule only turns a call the schema always rejects into
 * the accepted call, and never drops a field the schema declares:
 * - `reason`/`reasoning` at the root, or in a `queries` item, when that level does not declare it: every native tool takes
 *   a `reason`, so models add one to MCP calls too, and a server that forbids extra keys rejects the call;
 * - a `responseChars` inside a `queries` item, when only the root declares it, moves to the root (the largest wins);
 * - a `responseChars` beside a `cursor` (and no `queries`), when a root alternative takes the cursor alone;
 * - `queries` sent as a JSON string of an array is parsed.
 * Splitting an over-long `queries` batch is left to the model: it would change row indexes and pagination.
 */
export function mcpArgumentNormalizer(inputSchema: unknown): ((args: unknown) => unknown) | undefined {
	if (!isRecord(inputSchema)) return undefined;
	const root = liftedProperties(inputSchema);
	const rootDrops = ANNOTATIONS.filter((key) => !Object.hasOwn(root, key));
	const hasQueries = Object.hasOwn(root, "queries");
	const items = hasQueries ? itemProperties(resolveLocalRef(root.queries, inputSchema), inputSchema) : {};
	// An item schema with no readable properties is not judged: nothing is dropped from it.
	const itemsKnown = Object.keys(items).length > 0;
	const itemDrops = itemsKnown ? ANNOTATIONS.filter((key) => !Object.hasOwn(items, key)) : [];
	const liftResponseChars =
		itemsKnown && Object.hasOwn(root, "responseChars") && !Object.hasOwn(items, "responseChars");
	const cursorAlone = rootShapes(inputSchema).some((shape) => {
		const properties = isRecord(shape.properties) ? shape.properties : {};
		return (
			Object.hasOwn(properties, "cursor") &&
			!Object.hasOwn(properties, "responseChars") &&
			shape.additionalProperties === false
		);
	});
	if (rootDrops.length === 0 && !hasQueries && !cursorAlone) return undefined;
	return (args) => {
		if (!isRecord(args)) return args;
		let changed = false;
		const next: Schema = { ...args };
		for (const key of rootDrops)
			if (key in next) {
				delete next[key];
				changed = true;
			}
		if (hasQueries && typeof next.queries === "string") {
			try {
				const parsed: unknown = JSON.parse(next.queries);
				if (Array.isArray(parsed)) {
					next.queries = parsed;
					changed = true;
				}
			} catch {
				// Not JSON: validation reports the string as it came.
			}
		}
		if (Array.isArray(next.queries) && (itemDrops.length > 0 || liftResponseChars)) {
			const lifted: number[] = [];
			next.queries = next.queries.map((query: unknown) => {
				if (!isRecord(query)) return query;
				const keys = [...itemDrops, ...(liftResponseChars ? ["responseChars"] : [])].filter((key) => key in query);
				if (keys.length === 0) return query;
				changed = true;
				if (typeof query.responseChars === "number" && keys.includes("responseChars")) lifted.push(query.responseChars);
				return Object.fromEntries(Object.entries(query).filter(([key]) => !keys.includes(key)));
			});
			if (lifted.length > 0 && next.responseChars === undefined) next.responseChars = Math.max(...lifted);
		}
		if (cursorAlone && next.cursor !== undefined && next.queries === undefined && "responseChars" in next) {
			delete next.responseChars;
			changed = true;
		}
		return changed ? next : args;
	};
}
