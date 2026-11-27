/**
 * A server's requests for input from the user (MCP `elicitation/create`, form mode): read as untrusted data, shown by
 * the host's elicitation port, and the answer checked against what the server asked for before it is sent.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { clipText } from "@octocodeai/octocode-common/clip";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { McpError } from "../client/index.ts";
import { callContext } from "../elicitation-context.ts";
import { hostElicitation } from "../host.ts";
import type { McpElicitationAnswer, McpElicitationField } from "../host/elicitation.ts";

/** The reply a server gets, as the MCP spec shapes it. */
type ElicitResult =
	| { action: "accept"; content: Record<string, string | number | boolean> }
	| { action: "decline" | "cancel" };

/** A field with the limits its answer is checked against. */
interface Field extends McpElicitationField {
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
}

/** The request as the user is asked it, or why it is refused without asking. */
type Elicitation = { message: string; fields: Field[] } | { refused: string };

const INVALID_PARAMS = -32602;
/** One question per field; more than a form the host shows together is refused. */
const MAX_FIELDS = 8;
const MAX_OPTIONS = 50;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_LABEL_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 400;
/** How often the user is asked again after an answer the request does not allow. */
const MAX_ATTEMPTS = 3;
/** Field names and titles, letters and digits only, that ask for a credential: never collected through a server's form. */
const SECRET = /passw(?:or)?d|passphrase|passcode|secret|token|apikey|credential|privatekey/;

const oneLine = (text: string, max: number): string => clipText(visibleControls(text).replace(/\s+/g, " ").trim(), max);
const LIMITS = ["minLength", "maxLength", "minimum", "maximum"] as const;
const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function looksSecret(name: string, schema: Record<string, unknown>): boolean {
	const words = [name, typeof schema.title === "string" ? schema.title : ""];
	return (
		schema.format === "password" || words.some((word) => SECRET.test(word.toLowerCase().replace(/[^a-z0-9]/g, "")))
	);
}

/** The values a string field is limited to: `enum` (with `enumNames`), or `oneOf` of `const` and `title`. */
function optionsOf(schema: Record<string, unknown>): Field["options"] | string | undefined {
	const listed = Array.isArray(schema.enum) ? schema.enum : undefined;
	const titled = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (!listed && !titled) return undefined;
	const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
	const options = listed
		? listed.map((value, index) => ({ value, label: typeof names[index] === "string" ? names[index] : value }))
		: (titled ?? []).map((entry) => (isRecord(entry) ? { value: entry.const, label: entry.title ?? entry.const } : {}));
	if (options.length === 0 || options.length > MAX_OPTIONS) return `1 to ${MAX_OPTIONS} options are supported`;
	const shown: { value: string; label: string }[] = [];
	for (const { value, label } of options) {
		if (typeof value !== "string" || typeof label !== "string") return "options must be strings";
		shown.push({ value, label: oneLine(label, MAX_LABEL_CHARS) || oneLine(value, MAX_LABEL_CHARS) });
	}
	return shown;
}

function fieldOf(name: string, schema: unknown, required: boolean): Field | { refused: string } {
	if (!isRecord(schema)) return { refused: `field "${oneLine(name, 60)}" has no schema` };
	if (looksSecret(name, schema)) return { refused: `field "${oneLine(name, 60)}" looks like a secret` };
	const { type } = schema;
	if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")
		return { refused: `field "${oneLine(name, 60)}" is not a string, number, integer, boolean or enum` };
	const options = type === "string" ? optionsOf(schema) : undefined;
	if (typeof options === "string") return { refused: `field "${oneLine(name, 60)}": ${options}` };
	const label = typeof schema.title === "string" ? oneLine(schema.title, MAX_LABEL_CHARS) : "";
	const description = typeof schema.description === "string" ? oneLine(schema.description, MAX_DESCRIPTION_CHARS) : "";
	const limits: Pick<Field, (typeof LIMITS)[number]> = {};
	for (const key of LIMITS) {
		const value = finite(schema[key]);
		if (value !== undefined) limits[key] = value;
	}
	return {
		name,
		label: label || oneLine(name, MAX_LABEL_CHARS),
		...(description ? { description } : {}),
		type,
		...(options ? { options } : {}),
		required,
		...limits,
	};
}

/**
 * The `params` of an `elicitation/create` request. Only a flat form of string, number, integer, boolean and
 * single-choice fields is asked: URL mode, any other field (a list, an object), a field that looks like a secret and a
 * form too large to show are refused. Params that are not a request at all throw invalid params.
 */
export function readElicitation(params: unknown): Elicitation {
	if (!isRecord(params) || typeof params.message !== "string")
		throw new McpError(INVALID_PARAMS, "Invalid elicitation request: message must be a string");
	if (params.mode === "url") return { refused: "URL mode is not supported" };
	if (params.mode !== undefined && params.mode !== "form") return { refused: "only form mode is supported" };
	const schema = params.requestedSchema;
	if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties))
		throw new McpError(INVALID_PARAMS, "Invalid elicitation request: requestedSchema must be an object schema");
	const names = Object.keys(schema.properties);
	if (names.length > MAX_FIELDS) return { refused: `more than ${MAX_FIELDS} fields` };
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const fields: Field[] = [];
	for (const name of names) {
		const field = fieldOf(name, schema.properties[name], required.has(name));
		if ("refused" in field) return field;
		fields.push(field);
	}
	const message = visibleControls(params.message).trim();
	return { message: clipText(message, MAX_MESSAGE_CHARS), fields };
}

const TRUE = new Set(["true", "yes", "y"]);
const FALSE = new Set(["false", "no", "n"]);

/** The value of one field as the server's schema types it, or why what the user gave is not one. */
function valueOf(field: Field, given: string | number | boolean): string | number | boolean | { problem: string } {
	const problem = (what: string) => ({ problem: `"${field.label}" ${what}` });
	if (field.type === "boolean") {
		const word = typeof given === "string" ? given.trim().toLowerCase() : given;
		if (typeof word === "boolean") return word;
		return TRUE.has(String(word)) ? true : FALSE.has(String(word)) ? false : problem("must be yes or no");
	}
	if (field.type === "string") {
		if (typeof given !== "string") return problem("must be text");
		if (field.options && !field.options.some((option) => option.value === given))
			return problem("must be one of the listed options");
		if (field.minLength !== undefined && given.length < field.minLength)
			return problem(`needs at least ${field.minLength} characters`);
		if (field.maxLength !== undefined && given.length > field.maxLength)
			return problem(`takes at most ${field.maxLength} characters`);
		return given;
	}
	const number = typeof given === "string" && given.trim() ? Number(given.trim()) : given;
	if (typeof number !== "number" || !Number.isFinite(number)) return problem("must be a number");
	if (field.type === "integer" && !Number.isInteger(number)) return problem("must be a whole number");
	if (field.minimum !== undefined && number < field.minimum) return problem(`must be at least ${field.minimum}`);
	if (field.maximum !== undefined && number > field.maximum) return problem(`must be at most ${field.maximum}`);
	return number;
}

/**
 * The user's answer as the server receives it: only the requested fields, each typed as its schema says (typed text
 * becomes a number or a boolean). A field left empty is left out; a required one, or a value the schema does not allow,
 * is the `problem`.
 */
export function checkAnswer(
	fields: readonly Field[],
	content: Record<string, string | number | boolean>,
): { content: Record<string, string | number | boolean> } | { problem: string } {
	const checked: Record<string, string | number | boolean> = {};
	for (const field of fields) {
		const given = Object.hasOwn(content, field.name) ? content[field.name] : undefined;
		if (given === undefined || (typeof given === "string" && given.trim() === "")) {
			if (field.required) return { problem: `"${field.label}" needs a value` };
			continue;
		}
		const value = valueOf(field, given);
		if (typeof value === "object") return value;
		checked[field.name] = value;
	}
	return { content: checked };
}

/**
 * Answers the `elicitation/create` requests of the server `name` on `connection`. The user is asked through the host's
 * port, in the session of the tool call waiting on the connection: without a port or such a call nobody can be asked,
 * so the answer is `decline`, as it is for a request `readElicitation` refuses. An answer the request does not allow
 * is asked again with the reason, `MAX_ATTEMPTS` times in all, then answered `cancel`. `note` records a refusal.
 */
export function elicitationHandler(
	name: string,
	connection: object,
	note: (line: string) => void = () => {},
): (params: unknown, context: { signal: AbortSignal }) => Promise<ElicitResult> {
	return async (params, { signal }) => {
		const request = readElicitation(params);
		const call = callContext(connection);
		const port = hostElicitation();
		const refused =
			"refused" in request ? request.refused : !port ? "no host to ask" : !call ? "no tool call is waiting" : undefined;
		if ("refused" in request || !port || !call) {
			note(`elicitation declined: ${refused}`);
			return { action: "decline" };
		}
		const asking = AbortSignal.any([signal, call.signal]);
		let problem: string | undefined;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const answer: McpElicitationAnswer = await port.ask({
				server: name,
				message: request.message,
				fields: request.fields,
				...(problem ? { problem } : {}),
				signal: asking,
				ctx: call.ctx,
			});
			if (answer.action !== "accept") return { action: answer.action };
			const checked = checkAnswer(request.fields, answer.content);
			if ("content" in checked) return { action: "accept", content: checked.content };
			problem = checked.problem;
		}
		note(`elicitation cancelled: ${problem}`);
		return { action: "cancel" };
	};
}
