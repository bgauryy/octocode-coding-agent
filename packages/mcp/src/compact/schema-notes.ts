import { NOTE_KEYS } from "./schema-keywords.ts";
import { inert, isNode, isShapeless, literal, isValidationOnly, type Node, oneLine } from "./schema-nodes.ts";

/** Constraint notes and the note for shapeless union alternatives, reading `$ref`s through `deref`. */
export function createNotes(deref: (schema: unknown) => unknown) {
	const notes = (schema: unknown): string[] => {
		const node = deref(schema);
		if (!isNode(node)) return [];
		const out: string[] = [];
		for (const key of NOTE_KEYS) {
			const value = node[key];
			if (value === undefined || value === false) continue;
			if (isValidationOnly(key, value)) continue;
			if (key === "default") out.push(`default ${literal(value)}`);
			else if (value === true) out.push(key);
			else out.push(`${key} ${typeof value === "string" ? inert(value) : literal(value)}`);
		}
		if (Array.isArray(node.allOf)) for (const part of node.allOf) if (isShapeless(part)) out.push(...notes(part));
		if (Array.isArray(node.examples) && node.examples.length) out.push(`e.g. ${literal(node.examples[0])}`);
		return out;
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
			return [
				oneLine(node.description),
				required.length ? `${inert(required.join(" + "))} required` : "",
				...notes(node),
			]
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
	return { notes, alternativesNote };
}
