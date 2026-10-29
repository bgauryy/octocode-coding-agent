import { countRefs, resolveLocalRef } from "./schema-refs.ts";
import { NOTE_KEYS, SHAPE_KEYS, UNSUPPORTED_SHAPE } from "./schema-keywords.ts";
import type { JsonSchema } from "./types.ts";

type Node = { [key: string]: unknown };

const MAX_DEPTH = 400;

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
	/** Called with each object-typed field's name and its type rendered at top level, to find types repeated by tools. */
	onObject?: (field: string, type: string) => void;
	/** Type text (rendered at top level) → server-level alias name to print instead of the type. */
	hoisted?: ReadonlyMap<string, string>;
}

/** Longest `pattern` worth showing; longer ones (and patterns beside a `format`) are enforced by validation only. */
const MAX_PATTERN_CHARS = 48;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));
export const oneLine = (text: unknown) =>
	(typeof text === "string" ? text : "")
		.trim()
		.replace(/\s*\n\s*/g, " ")
		.replace(/\*\//g, "*\\/");
export const isShapeless = (schema: unknown): boolean =>
	schema === true || (isNode(schema) && !SHAPE_KEYS.some((key) => key in schema));

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
	const notes = (schema: unknown): string[] => {
		const node = deref(schema);
		if (!isNode(node)) return [];
		const out: string[] = [];
		for (const key of NOTE_KEYS) {
			const value = node[key];
			if (value === undefined || value === false) continue;
			if (
				key === "pattern" &&
				(node.format !== undefined || (typeof value === "string" && value.length > MAX_PATTERN_CHARS))
			)
				continue;
			// zod and others emit the JavaScript safe-integer bound for `.int()`; it limits nothing a caller would send.
			if ((key === "maximum" || key === "minimum") && Math.abs(Number(value)) >= Number.MAX_SAFE_INTEGER) continue;
			if (key === "default") out.push(`default ${JSON.stringify(value)}`);
			else if (value === true) out.push(key);
			else out.push(`${key} ${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
		if (Array.isArray(node.allOf)) for (const part of node.allOf) if (isShapeless(part)) out.push(...notes(part));
		if (Array.isArray(node.examples) && node.examples.length) out.push(`e.g. ${JSON.stringify(node.examples[0])}`);
		return out;
	};
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
	/**
	 * What alternatives without a shape require (`{ required: [...] }`, a `format`), as a comment after the type: they
	 * add no TypeScript type but still constrain the value. Empty when there are none or one of them allows anything.
	 */
	const alternativesNote = (schema: Node, alternatives: unknown[]): string => {
		const shapeless = alternatives.filter(isShapeless);
		const texts = shapeless.map((alternative) => {
			const node = isNode(alternative) ? alternative : {};
			const required = Array.isArray(node.required) ? node.required.map(String) : [];
			return [oneLine(node.description), required.length ? `${required.join(" + ")} required` : "", ...notes(node)]
				.filter(Boolean)
				.join(", ");
		});
		if (!texts.length || texts.some((text) => !text)) return "";
		const kind =
			shapeless.length < alternatives.length
				? "or"
				: Array.isArray(schema.anyOf)
					? "at least one of"
					: "exactly one of";
		return ` /* ${kind}: ${oneLine(texts.join(" | "))} */`;
	};

	function render(schema: unknown, indent: string, path: string, parent?: Node): string {
		if (++depth > MAX_DEPTH) {
			depth--;
			return "unknown /* schema too deep */";
		}
		try {
			return renderNode(schema, indent, path, parent);
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
		const base = renderObject(
			{ type: "object", properties: sharedProperties, required: requiredEverywhere },
			indent,
			path,
			parent,
		);
		const sharedRequired = new Set(requiredEverywhere);
		const variants = [
			...new Set(
				branches.map((node, index) => {
					if (!isNode(node) || node.anyOf || node.oneOf || !isNode(node.properties))
						return described(live[index], render(live[index], indent, path, parent));
					const branchRequired = requiredOf(node);
					const own: Node = {};
					for (const [key, value] of Object.entries(node.properties)) {
						if (!isShapeless(value)) own[key] = value;
						// A placeholder this branch alone requires: show the parent's field as required here.
						// Type only: the shared field above already carries its doc and constraints.
						else if (branchRequired.has(key) && !sharedRequired.has(key) && key in sharedProperties) {
							const typed = shapeOnly(deref(sharedProperties[key]));
							if (isNode(typed)) restated.add(typed);
							own[key] = typed;
						}
					}
					if (!Object.keys(own).length) return "";
					// The parent's `required` also binds keys that only the branches define.
					const required = Object.keys(own).filter((key) => branchRequired.has(key) || parentRequired.has(key));
					return described(node, renderObject({ type: "object", properties: own, required }, indent, path));
				}),
			),
		].filter(Boolean);
		return variants.length ? `${base} & (${variants.join(" | ")})` : base;
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

	function renderObject(schema: Node, indent: string, path: string, parent?: Node): string {
		const properties = isNode(schema.properties) ? schema.properties : {};
		const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []);
		const extra = schema.additionalProperties;
		const keys = Object.keys(properties);
		if (!keys.length)
			return isNode(extra) ? `Record<string, ${render(extra, indent, path)}>` : "Record<string, unknown>";
		const inner = `${indent}\t`;
		let out = "{\n";
		for (const key of keys) {
			let property = properties[key];
			const inherited = parent && isNode(parent.properties) ? parent.properties[key] : undefined;
			if (isShapeless(property) && inherited !== undefined)
				property = { ...(isNode(inherited) ? inherited : {}), ...(isNode(property) ? property : {}) };
			const fieldPath = path ? `${path}.${key}` : key;
			const doc = docText(property, fieldPath);
			if (!isNode(property) || !restated.has(property)) options.onDoc?.(key, doc);
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
		if (!isNode(node) || !isNode(node.properties) || node.anyOf || node.oneOf || node.allOf)
			return render(property, indent, path);
		const topLevel = render(property, "", path);
		options.onObject?.(key, topLevel);
		return options.hoisted?.get(topLevel) ?? render(property, indent, path);
	}

	const type = render(root, "", "");
	return { type, aliases: [...aliases].map(([id, body]) => `type ${aliasName(id)} = ${body || "unknown"};`) };
}

const isSimple = (text: string) => !/[{\n]/.test(text) && text.length <= 60;

/** A schema node with only the keywords that give it a shape: no description, constraints or examples. */
function shapeOnly(schema: unknown): unknown {
	if (!isNode(schema)) return schema;
	return Object.fromEntries(Object.entries(schema).filter(([key]) => SHAPE_KEYS.includes(key) || key === "required"));
}
