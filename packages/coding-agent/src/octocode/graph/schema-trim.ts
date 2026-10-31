import { isRecord } from "@octocodeai/octocode-contracts/guards";

type Json = Record<string, unknown>;

const REF_PREFIX = "#/$defs/";
/** A definition this small costs less inline than the `{"$ref":"#/$defs/x"}` that points at it. */
const INLINE_BELOW = 40;

const refName = (node: Json): string | undefined =>
	typeof node.$ref === "string" && node.$ref.startsWith(REF_PREFIX) ? node.$ref.slice(REF_PREFIX.length) : undefined;

/** The definition with its `$ref` chain folded in: a node's own keywords win over the ones it points at. */
function flatten(name: string, defs: Json, seen: string[] = []): Json {
	const def = defs[name];
	if (!isRecord(def) || seen.includes(name)) return {};
	const next = refName(def);
	const { $ref: _ref, ...own } = def;
	return next === undefined ? own : { ...flatten(next, defs, [...seen, name]), ...own };
}

function walk(node: unknown, visit: (node: Json) => void): void {
	if (Array.isArray(node)) for (const item of node) walk(item, visit);
	else if (isRecord(node)) {
		visit(node);
		for (const value of Object.values(node)) walk(value, visit);
	}
}

function refsIn(node: unknown): string[] {
	const names: string[] = [];
	walk(node, (candidate) => {
		const name = refName(candidate);
		if (name !== undefined) names.push(name);
	});
	return names;
}

/**
 * The same schema with its `$defs` reduced to the definitions worth sharing. The CLI declares every field type as a
 * definition that points at another (a described `path` points at a `string`), so chains collapse into one definition
 * and a definition that is tiny or used once moves to its single use. Keywords are only moved, never dropped, so the
 * schema accepts and refuses exactly the same requests. A schema without `$defs`, with a reference it cannot resolve
 * or with a recursive definition is returned as it is.
 */
export function trimSchemaDefinitions<T extends Json>(schema: T): T {
	const { $defs: defs, ...rest } = schema;
	if (!isRecord(defs)) return schema;
	const flat: Record<string, Json> = Object.fromEntries(Object.keys(defs).map((name) => [name, flatten(name, defs)]));
	const uses = new Map<string, number>();
	for (const name of [...refsIn(rest), ...Object.values(flat).flatMap(refsIn)])
		uses.set(name, (uses.get(name) ?? 0) + 1);
	const unresolved = [...uses.keys()].some((name) => !(name in flat));
	const recursive = Object.entries(flat).some(([name, def]) => {
		const reach = (next: unknown, seen: Set<string>): boolean =>
			refsIn(next).some((ref) => ref === name || (!seen.has(ref) && reach(flat[ref], seen.add(ref))));
		return reach(def, new Set());
	});
	if (unresolved || recursive) return schema;
	const inline = (name: string): boolean =>
		(uses.get(name) ?? 0) <= 1 || JSON.stringify(flat[name]).length < INLINE_BELOW;

	const rewrite = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(rewrite);
		if (!isRecord(node)) return node;
		const name = refName(node);
		const { $ref: _ref, ...own } = node;
		const body = Object.fromEntries(Object.entries(own).map(([key, value]) => [key, rewrite(value)]));
		if (name === undefined) return body;
		return inline(name) ? { ...(rewrite(flat[name]) as Json), ...body } : { ...body, $ref: `${REF_PREFIX}${name}` };
	};

	const out = rewrite(rest) as Json;
	const kept = Object.keys(flat).filter((name) => !inline(name));
	if (kept.length > 0) out.$defs = Object.fromEntries(kept.map((name) => [name, rewrite(flat[name])]));
	return out as T;
}
