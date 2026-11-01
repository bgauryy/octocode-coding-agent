import { countRefs, resolveLocalRef } from "./schema-refs.ts";
import { SHAPE_KEYS, UNSUPPORTED_SHAPE } from "./schema-keywords.ts";
import { createNotes } from "./schema-notes.ts";
import {
	identifier,
	isHoistableUnion,
	isNode,
	isShapeless,
	isSimple,
	type Node,
	oneLine,
	shapeOnly,
} from "./schema-nodes.ts";
import type { JsonSchema } from "./types.ts";

const MAX_DEPTH = 400;
/** Branches of a union at least this long are candidates for a server-level alias when repeated. */
const HOISTED_BRANCHES_MIN_CHARS = 200;

export interface SchemaToTsOptions {
	/** Prefix for aliases, so tools sharing `$defs` ids (`0`, `4`) never collide. */
	scope: string;
	/** Replacement descriptions by dotted field path. */
	fieldDocs?: Record<string, string>;
	/**
	 * Field name → doc text documented once for the server; a field whose doc equals it is rendered without one. The
	 * renderer shares a doc only when every field of that name has it, so the name alone attributes it exactly.
	 */
	sharedDocs?: ReadonlyMap<string, string>;
	/** Called with each field's name and doc text ("" for none), so a first pass can find docs shared across tools. */
	onDoc?: (field: string, doc: string) => void;
	/** Called with each field's dotted path (as `fieldDocs` addresses it) and whether that occurrence is required. */
	onField?: (path: string, required: boolean) => void;
	/**
	 * Called with each object-typed field's name, its type rendered at top level and its schema node, to find types
	 * repeated by tools or within one.
	 */
	onObject?: (field: string, type: string, source: object) => void;
	/** Type text (rendered at top level) → server-level alias name to print instead of the type. */
	hoisted?: ReadonlyMap<string, string>;
}

export { isShapeless };

/**
 * Renders a JSON Schema (draft-04, draft-07 or 2020-12, including zod v3 `zod-to-json-schema` and zod v4
 * `z.toJSONSchema` output) as a TypeScript type. Shape is lossless; constraints become JSDoc notes.
 */
export function schemaToTs(root: JsonSchema, options: SchemaToTsOptions): { type: string; aliases: string[] } {
	const rootNode = isNode(root) ? root : {};
	const uses = countRefs(rootNode);
	const aliases = new Map<string, string>();
	const inProgress = new Set<string>();
	/** Fields a variant restates as required with type only; the shared field carries their doc. */
	const restated = new WeakSet<object>();
	let depth = 0;
	// While > 0, types are written without the server-level aliases: the text a repeat is recognised by.
	let raw = 0;
	const aliased = () => (raw ? undefined : options.hoisted);
	const unaliased = <T>(compute: () => T): T => {
		raw++;
		try {
			return compute();
		} finally {
			raw--;
		}
	};

	// A pointer other than a definition (`#`, `#/properties/a`) gets a `$` name, which no definition name produces.
	const aliasName = (id: string) =>
		options.scope +
		(id.startsWith("#")
			? `$${id.slice(2).replace(/\W/g, "_") || "root"}`
			: /^[A-Za-z]\w*$/.test(id)
				? id[0].toUpperCase() + id.slice(1)
				: `T${id.replace(/\W/g, "_")}`);
	const refTarget = (ref: unknown) => resolveLocalRef(rootNode, ref);
	/** A `$ref` node with its target's keywords merged under its own (siblings of `$ref` win). */
	const deref = (schema: unknown): unknown => {
		let current = schema;
		for (let hops = 0; isNode(current) && current.$ref !== undefined && hops < 20; hops++) {
			const target = refTarget(current.$ref);
			if (!target || !isNode(target[1])) return current;
			const { $ref: _ref, ...rest } = current;
			current = { ...target[1], ...rest };
		}
		return current;
	};
	const { notes, alternativesNote } = createNotes(deref);
	const docText = (schema: unknown, path: string) => {
		const node = deref(schema);
		const description = options.fieldDocs?.[path] ?? (isNode(node) ? node.description : undefined);
		const noteList = notes(schema);
		return [oneLine(description), noteList.length ? `(${oneLine(noteList.join(", "))})` : ""].filter(Boolean).join(" ");
	};
	/** A union branch or tuple item's type, after its own description. */
	const described = (schema: unknown, type: string) => {
		const node = deref(schema);
		const description = oneLine(isNode(node) ? node.description : undefined);
		return description ? `/** ${description} */ ${type}` : type;
	};

	function render(schema: unknown, indent: string, path: string, parent?: Node): string {
		if (++depth > MAX_DEPTH) {
			depth--;
			return "unknown /* schema too deep */";
		}
		try {
			const text = renderNode(schema, indent, path, parent);
			if (!(options.onObject || options.hoisted) || !isNode(schema) || !isHoistableUnion(text)) return text;
			options.onObject?.("value", text, schema);
			return aliased()?.get(text) ?? text;
		} finally {
			depth--;
		}
	}

	function renderNode(schema: unknown, indent: string, path: string, parent?: Node): string {
		if (schema === true || schema === undefined) return "unknown";
		if (schema === false) return "never";
		if (!isNode(schema)) return "unknown";
		if (schema.$ref !== undefined) return renderRef(schema, indent, path, parent);
		if (schema.const !== undefined) return JSON.stringify(schema.const);
		if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
		const alternatives = Array.isArray(schema.anyOf)
			? schema.anyOf
			: Array.isArray(schema.oneOf)
				? schema.oneOf
				: undefined;
		if (alternatives) return renderUnion(schema, alternatives, indent, path, parent);
		if (Array.isArray(schema.allOf)) return renderIntersection(schema, schema.allOf, indent, path, parent);
		if (Array.isArray(schema.type))
			return schema.type.map((type) => render({ ...schema, type }, indent, path, parent)).join(" | ");
		const type =
			typeof schema.type === "string"
				? schema.type
				: schema.properties
					? "object"
					: schema.items || schema.prefixItems
						? "array"
						: undefined;
		switch (type) {
			case "string":
			case "boolean":
			case "null":
				return type;
			case "integer":
			case "number":
				return "number";
			case "array":
				return renderArray(schema, indent, path);
			case "object":
				return renderObject(schema, indent, path, parent);
			default:
				return "unknown";
		}
	}

	function renderRef(schema: Node, indent: string, path: string, parent?: Node): string {
		if (
			SHAPE_KEYS.some(
				(key) =>
					key !== "$ref" &&
					key in schema &&
					(key !== "allOf" || !Array.isArray(schema.allOf) || schema.allOf.some((part) => !isShapeless(part))),
			) ||
			"required" in schema
		)
			return UNSUPPORTED_SHAPE;
		const target = refTarget(schema.$ref);
		if (!target) return "unknown /* unresolved $ref */";
		const [id, body] = target;
		if (inProgress.has(id)) {
			if (!aliases.has(id)) aliases.set(id, "");
			return aliasName(id);
		}
		inProgress.add(id);
		const inline = render(body, indent, path, parent);
		inProgress.delete(id);
		const recursive = aliases.has(id);
		if (!recursive && (isSimple(inline) || (uses.get(id) ?? 0) < 2)) return inline;
		if (!aliases.get(id)) {
			inProgress.add(id);
			aliases.set(id, render(body, "", path, parent));
			inProgress.delete(id);
		}
		return aliasName(id);
	}

	/** `Shared & (A | B)` when the union's parent declares the shared fields; `{}` placeholders mean "as on the parent". */
	function renderUnion(schema: Node, alternatives: unknown[], indent: string, path: string, parent?: Node): string {
		return renderShapes(schema, alternatives, indent, path, parent) + alternativesNote(schema, alternatives);
	}

	function renderShapes(schema: Node, alternatives: unknown[], indent: string, path: string, parent?: Node): string {
		const live = alternatives.filter((alternative) => !isShapeless(alternative));
		const shared = isNode(schema.properties) && Object.keys(schema.properties).length ? schema : undefined;
		if (!live.length && !shared) {
			// Only constraints (`format` per branch): the type comes from the keywords beside the union.
			const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
			return render(rest, indent, path, parent);
		}
		if (!shared && live.length < alternatives.length && live.length > 0) return UNSUPPORTED_SHAPE;
		if (!shared) {
			// The union's own `required` still binds the keys each branch defines (`sort: { required: [by, order] }`).
			const outer = Array.isArray(schema.required) ? schema.required.map(String) : [];
			const parts = [
				...new Set(
					live.map((alternative) => {
						const node = deref(alternative);
						if (!outer.length || !isNode(node) || !isNode(node.properties) || node.anyOf || node.oneOf)
							return described(alternative, render(alternative, indent, path, parent));
						const own = Array.isArray(node.required) ? node.required.map(String) : [];
						const required = [...new Set([...own, ...outer.filter((key) => key in (node.properties as Node))])];
						return described(node, render({ ...node, required }, indent, path, parent));
					}),
				),
			];
			return parts.length ? parts.join(" | ") : "unknown";
		}
		const sharedProperties = shared.properties as Node;
		const requiredOf = (node: unknown) =>
			new Set(isNode(node) && Array.isArray(node.required) ? node.required.map(String) : []);
		const parentRequired = requiredOf(shared);
		const branches = live.map(deref);
		const objectBranches = branches.filter(
			(node): node is Node => isNode(node) && !node.anyOf && !node.oneOf && isNode(node.properties),
		);
		// A key every branch requires is required on the shared part, even when the parent's own `required` omits it.
		const requiredEverywhere = Object.keys(sharedProperties).filter(
			(key) =>
				parentRequired.has(key) ||
				(objectBranches.length === live.length &&
					objectBranches.length > 0 &&
					objectBranches.every((node) => requiredOf(node).has(key))),
		);
		// A shapeless shared field a branch types (`operation: unknown` beside `operation: "resolve"`) is a placeholder: the
		// branches carry its type and doc, so it records none of its own.
		const placeholders = new Set(
			Object.keys(sharedProperties).filter(
				(key) =>
					isShapeless(sharedProperties[key]) &&
					branches.some((node) => isNode(node) && isNode(node.properties) && !isShapeless(node.properties[key])),
			),
		);
		const base = renderObject(
			{ type: "object", properties: sharedProperties, required: requiredEverywhere },
			indent,
			path,
			parent,
			placeholders,
		);
		// What a nested union's own fields restate (`mainGoal?: unknown`) is read against these shared fields.
		const inheritable: Node = {
			properties: {
				...(isNode(parent?.properties) ? parent.properties : {}),
				...Object.fromEntries(Object.entries(sharedProperties).filter(([, value]) => !isShapeless(value))),
			},
		};
		const sharedRequired = new Set(requiredEverywhere);
		const variantsAt = (at: string) =>
			[
				...new Set(
					branches.map((node, index) => {
						if (!isNode(node) || node.anyOf || node.oneOf || !isNode(node.properties))
							return described(live[index], render(live[index], at, path, inheritable));
						const branchRequired = requiredOf(node);
						const own: Node = {};
						for (const [key, value] of Object.entries(node.properties)) if (!isShapeless(value)) own[key] = value;
						// A key this branch alone requires, as a placeholder or only in its `required` (`{ required: [matchString] }`):
						// show the parent's field as required here. Type only: the shared field above already carries its doc.
						for (const key of branchRequired) {
							if (key in own || sharedRequired.has(key) || !(key in sharedProperties)) continue;
							// A bare `$ref` stays one, so the restated field names the shared alias instead of writing the type again.
							const typed = shapeOnly(sharedProperties[key]);
							if (isNode(typed)) restated.add(typed);
							own[key] = typed;
						}
						if (!Object.keys(own).length) return "";
						// The parent's `required` also binds keys that only the branches define.
						const required = Object.keys(own).filter((key) => branchRequired.has(key) || parentRequired.has(key));
						return described(node, renderObject({ type: "object", properties: own, required }, at, path));
					}),
				),
			].filter(Boolean);
		if (!(options.onObject || options.hoisted)) {
			const variants = variantsAt(indent);
			return variants.length ? `${base} & (${variants.join(" | ")})` : base;
		}
		// The branches several tools repeat (`ghGetFileContent` and `localFetch` differ only in their leading fields) become
		// one alias, found by their text at top level without other aliases.
		const topLevel = unaliased(() => variantsAt("")).join(" | ");
		if (!topLevel) return base;
		if (topLevel.length >= HOISTED_BRANCHES_MIN_CHARS)
			options.onObject?.(`${path.split(".").pop() || "input"}Variants`, topLevel, schema);
		const alias = aliased()?.get(topLevel);
		if (alias) return `${base} & ${alias}`;
		const variants = options.hoisted
			? variantsAt(indent)
			: variantsAt("").map((text) => text.replace(/\n/g, `\n${indent}`));
		return `${base} & (${variants.join(" | ")})`;
	}

	function renderIntersection(schema: Node, parts: unknown[], indent: string, path: string, parent?: Node): string {
		const { allOf: _allOf, ...rest } = schema;
		const shaped = parts.filter((part) => !isShapeless(part)).map((part) => render(part, indent, path, parent));
		if (SHAPE_KEYS.some((key) => rest[key] !== undefined)) shaped.unshift(render(rest, indent, path, parent));
		return shaped.length ? shaped.map((part) => (part.includes(" | ") ? `(${part})` : part)).join(" & ") : "unknown";
	}

	function renderArray(schema: Node, indent: string, path: string): string {
		const tuple = Array.isArray(schema.prefixItems)
			? schema.prefixItems
			: Array.isArray(schema.items)
				? schema.items
				: undefined;
		if (tuple) {
			const closed = Array.isArray(schema.prefixItems) ? schema.items === false : schema.additionalItems === false;
			if (schema.minItems !== tuple.length || (!closed && schema.maxItems !== tuple.length)) return UNSUPPORTED_SHAPE;
			return `[${tuple.map((item) => described(item, render(item, indent, path))).join(", ")}]`;
		}
		const item = render(schema.items, indent, path);
		const itemNode = deref(schema.items);
		const itemDoc = [
			oneLine(isNode(itemNode) ? itemNode.description : undefined),
			oneLine(notes(schema.items).join(", ")),
		].filter(Boolean);
		const wrapped = /[|&]|\/\*/.test(item) ? `(${item})[]` : `${item}[]`;
		return itemDoc.length ? `${wrapped} /* each: ${itemDoc.join("; ")} */` : wrapped;
	}

	function renderObject(
		schema: Node,
		indent: string,
		path: string,
		parent?: Node,
		placeholders?: ReadonlySet<string>,
	): string {
		const properties = isNode(schema.properties) ? schema.properties : {};
		const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []);
		const extra = schema.additionalProperties;
		const keys = Object.keys(properties);
		if (!keys.length)
			return isNode(extra) ? `Record<string, ${render(extra, indent, path)}>` : "Record<string, unknown>";
		const inner = `${indent}\t`;
		let out = "{\n";
		for (const key of keys) {
			const property = properties[key];
			const fieldPath = path ? `${path}.${key}` : key;
			const inherited = isNode(parent?.properties) ? parent.properties[key] : undefined;
			if (isShapeless(property) && inherited !== undefined && !isShapeless(inherited)) {
				// "As on the parent": an optional field adds nothing to the intersection; a required one says so, untyped.
				if (!required.has(key)) continue;
				options.onField?.(fieldPath, true);
				out += `${inner}${identifier(key)}: unknown;\n`;
				continue;
			}
			const doc = docText(property, fieldPath);
			const placeholder = !doc && placeholders?.has(key);
			if (!placeholder && (!isNode(property) || !restated.has(property))) options.onDoc?.(key, doc);
			options.onField?.(fieldPath, required.has(key));
			const shown = doc && options.sharedDocs?.get(key) !== doc ? `/** ${doc} */ ` : "";
			out += `${inner}${shown}${identifier(key)}${required.has(key) ? "" : "?"}: ${fieldType(property, inner, fieldPath, key)};\n`;
		}
		if (isNode(extra)) out += `${inner}[key: string]: ${render(extra, inner, path)};\n`;
		return `${out}${indent}}`;
	}

	/** A field's type, or the server-level alias for it when tools repeat the same object type. */
	function fieldType(property: unknown, indent: string, path: string, key: string): string {
		if (!options.onObject && !options.hoisted) return render(property, indent, path);
		const node = deref(property);
		if (!isNode(node) || !(isNode(node.properties) || isNode(node.additionalProperties)))
			return render(property, indent, path);
		const topLevel = unaliased(() => render(property, "", path));
		options.onObject?.(key, topLevel, property as object);
		return aliased()?.get(topLevel) ?? render(property, indent, path);
	}

	const type = render(root, "", "");
	return { type, aliases: [...aliases].map(([id, body]) => `type ${aliasName(id)} = ${body || "unknown"};`) };
}
