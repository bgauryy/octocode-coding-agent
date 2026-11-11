/** Local `$ref` resolution for the renderer: `#`, `#/$defs/<id>`, `#/definitions/<id>` and any other JSON pointer. */

type Node = { [key: string]: unknown };

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

const DEFINITION = /^#\/(?:\$defs|definitions)\/([^/]+)$/;

/** One JSON-pointer segment with `~1`, `~0` and percent escapes undone; undefined when malformed. */
function segment(text: string): string | undefined {
	try {
		return decodeURIComponent(text).replaceAll("~1", "/").replaceAll("~0", "~");
	} catch {
		return undefined;
	}
}

/**
 * The alias id and target of a local reference, or undefined when it does not resolve within `root` (a remote
 * document, a missing definition). A definition's id is its name, so aliases read `Scope_Name`; any other pointer's
 * id is the pointer itself.
 */
export function resolveLocalRef(root: unknown, ref: unknown): [string, unknown] | undefined {
	if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) return undefined;
	let node = root;
	for (const raw of ref === "#" ? [] : ref.slice(2).split("/")) {
		const key = segment(raw);
		if (key === undefined || !(isNode(node) || Array.isArray(node)) || !Object.hasOwn(node, key)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	const definition = DEFINITION.exec(ref);
	const id = definition ? segment(definition[1]) : ref;
	return id === undefined ? undefined : [id, node];
}

/** A `$ref` node with its target's keywords merged under its own (siblings of `$ref` win), following up to 20 hops. */
export function derefNode(root: Node, schema: unknown): unknown {
	let current = schema;
	for (let hops = 0; isNode(current) && current.$ref !== undefined && hops < 20; hops++) {
		const target = resolveLocalRef(root, current.$ref);
		if (!target || !isNode(target[1])) return current;
		const { $ref: _ref, ...rest } = current;
		current = { ...target[1], ...rest };
	}
	return current;
}

/** How often each resolvable reference target is used, by alias id. */
export function countRefs(root: Node): Map<string, number> {
	const uses = new Map<string, number>();
	const seen = new Set<unknown>();
	const walk = (value: unknown) => {
		if (seen.has(value)) return;
		if (Array.isArray(value)) return value.forEach(walk);
		if (!isNode(value)) return;
		seen.add(value);
		const target = resolveLocalRef(root, value.$ref);
		if (target) uses.set(target[0], (uses.get(target[0]) ?? 0) + 1);
		for (const child of Object.values(value)) walk(child);
	};
	walk(root);
	return uses;
}
