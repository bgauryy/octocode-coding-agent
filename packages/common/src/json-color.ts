/** Anything that colours text by a theme token name. */
export interface TokenColors {
	fg(color: string, text: string): string;
}

/** A piece of a JSON document: `color` is the theme token that colours it, absent for layout (indentation, spacing). */
export interface JsonSpan {
	color?: string;
	text: string;
}

/** The colours code blocks give JSON tokens (keys, strings, numbers and `true`/`false`/`null`, punctuation). */
const KEY = "syntaxVariable";
const STRING = "syntaxString";
const VALUE = "syntaxNumber";
const PUNCTUATION = "syntaxPunctuation";

/** Larger results stay plain: colouring runs on the drawing thread. */
const MAX_JSON_CHARS = 256 * 1024;

const isSpace = (ch: string | undefined) => ch === " " || ch === "\n" || ch === "\r" || ch === "\t";

/** Whether `text` is one JSON object or array, as MCP servers that answer in JSON send it; any other text stays plain. */
export function isJsonDocument(text: string): boolean {
	if (text.length > MAX_JSON_CHARS) return false;
	const first = text[0];
	const last = text.at(-1);
	if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * `json` (a document `isJsonDocument` accepted) split token by token. `indent` lays it out two spaces per level;
 * otherwise the server's own layout stays. Tokens are copied as sent, never parsed, so no number loses precision.
 * With `maxChars`, only the tokens that start before that offset are coloured (and `indent` should be off).
 */
export function jsonSpans(json: string, indent: boolean, maxChars = Infinity): JsonSpan[] {
	const out: JsonSpan[] = [];
	const paint = (color: string, text: string) => out.push({ color, text });
	const mark = (text: string) => paint(PUNCTUATION, text);
	let depth = 0;
	const newline = () => {
		if (indent) out.push({ text: `\n${"  ".repeat(depth)}` });
	};
	const nextSolid = (from: number) => {
		let at = from;
		while (isSpace(json[at])) at++;
		return at;
	};
	let i = 0;
	while (i < json.length) {
		// Past `maxChars` (a collapsed row's visible part) the rest is copied as sent, uncoloured.
		if (i >= maxChars) {
			out.push({ text: json.slice(i) });
			break;
		}
		const ch = json[i];
		if (ch === '"') {
			let end = i + 1;
			while (end < json.length && json[end] !== '"') end += json[end] === "\\" ? 2 : 1;
			paint(json[nextSolid(end + 1)] === ":" ? KEY : STRING, json.slice(i, end + 1));
			i = end + 1;
		} else if (ch === "{" || ch === "[") {
			const close = ch === "{" ? "}" : "]";
			const after = nextSolid(i + 1);
			if (json[after] === close) {
				mark(ch + close);
				i = after + 1;
				continue;
			}
			depth++;
			mark(ch);
			newline();
			i++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			newline();
			mark(ch);
			i++;
		} else if (ch === ",") {
			mark(ch);
			newline();
			i++;
		} else if (ch === ":") {
			mark(ch);
			if (indent) out.push({ text: " " });
			i++;
		} else if (isSpace(ch)) {
			const end = nextSolid(i);
			if (!indent) out.push({ text: json.slice(i, end) });
			i = end;
		} else {
			let end = i;
			while (end < json.length && !isSpace(json[end]) && !",:]}".includes(json[end])) end++;
			paint(VALUE, json.slice(i, end));
			i = end;
		}
	}
	return out;
}

/** `jsonSpans` as one string, each coloured token wrapped by the theme. */
export function colorJson(json: string, theme: TokenColors, indent: boolean, maxChars = Infinity): string {
	return jsonSpans(json, indent, maxChars)
		.map(({ color, text }) => (color ? theme.fg(color, text) : text))
		.join("");
}
