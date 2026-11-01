import { SHAPE_KEYS } from "./schema-keywords.ts";

export type Node = { [key: string]: unknown };

/**
 * Constraints left out of the text: validation enforces them and its error names the one a call breaks. A `pattern` or
 * `maxLength` rarely helps a model compose a valid value; a minimum of 1 for a string, list or object only says "not
 * empty"; the bound zod emits for `.int()` or an API's largest id limits nothing a caller would send.
 */
export function isValidationOnly(key: string, value: unknown): boolean {
	if (key === "pattern" || key === "maxLength") return true;
	if (key === "minLength" || key === "minItems" || key === "minProperties") return value === 1;
	return (key === "maximum" || key === "minimum") && Math.abs(Number(value)) >= 1e9;
}

export const isNode = (value: unknown): value is Node =>
	typeof value === "object" && value !== null && !Array.isArray(value);
export const identifier = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));
export const oneLine = (text: unknown) =>
	(typeof text === "string" ? text : "")
		.trim()
		.replace(/\s*\n\s*/g, " ")
		.replace(/\*\//g, "*\\/");
export const isShapeless = (schema: unknown): boolean =>
	schema === true || (isNode(schema) && !SHAPE_KEYS.some((key) => key in schema));

/** A short type on one line, written where it is used. */
export const isSimple = (text: string) => !/[{\n]/.test(text) && text.length <= 60;

/**
 * A union of plain types repeated enough to name once: one line, no object, literal or comment in it. Literals stay
 * where the model reads them (an enum's values decide a call).
 */
const SIMPLE_UNION_MIN_CHARS = 40;
export const isHoistableUnion = (text: string) =>
	text.length >= SIMPLE_UNION_MIN_CHARS && text.includes(" | ") && !/[{\n"]|\/\*/.test(text);

/** A schema node with only the keywords that give it a shape: no description, constraints or examples. */
export function shapeOnly(schema: unknown): unknown {
	if (!isNode(schema)) return schema;
	return Object.fromEntries(Object.entries(schema).filter(([key]) => SHAPE_KEYS.includes(key) || key === "required"));
}
