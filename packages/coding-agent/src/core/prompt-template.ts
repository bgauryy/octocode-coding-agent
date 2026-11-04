import fs from "node:fs";
import path from "node:path";
import { getInstructionsDir } from "../config.ts";

/**
 * The renderer for the Markdown files under `instructions/`. Prompt prose lives in those files; the TypeScript beside
 * them derives named flags once and passes them in. The syntax is deliberately small:
 *
 * - `{{name}}` inserts a value (never rescanned for directives);
 * - `{{#if flag}}…{{else}}…{{/if}}` and `{{#unless flag}}…{{/unless}}`, inline or as lines of their own (a block whose
 *   condition is false then leaves no blank line); a flag is true unless it is false, 0, "" or undefined;
 * - `{{> shared/rule.md}}` inserts another instruction file, rendered with the same values, so a rule shared by several
 *   prompts has one source (alone on its line, it leaves no blank line when it renders empty);
 * - `<!-- … -->` comments are removed, so a rationale can sit beside the text it explains.
 *
 * A name the caller did not pass is an error, not an empty string. The newline that ends the file's last line is not part
 * of the text. It lives in `core/` because core assembles the system prompt and may not import `octocode/`; octocode modules may import core.
 */
export type TemplateValues = Record<string, string | number | boolean | undefined>;

type Node =
	| string
	| { variable: string }
	| { include: string; line: boolean }
	| { flag: string; negate: boolean; ifTrue: Node[]; otherwise: Node[] };

const COMMENT = /<!--(?:(?!-->)[\s\S])*-->/g;
const WHOLE_LINE_COMMENT = /^[ \t]*<!--(?:(?!-->)[\s\S])*-->[ \t]*(?:\n|$)/gm;
const TAG = /\{\{\s*(?:(#if|#unless)\s+([\w.]+)|(else)|(\/if|\/unless)|([\w.]+)|>\s*([\w./-]+))\s*\}\}/g;

interface Frame {
	kind: "#if" | "#unless";
	flag: string;
	ifTrue: Node[];
	otherwise?: Node[];
}

function parse(source: string): Node[] {
	const root: Node[] = [];
	const stack: Frame[] = [];
	const current = (): Node[] => {
		const frame = stack.at(-1);
		return frame ? (frame.otherwise ?? frame.ifTrue) : root;
	};
	let cursor = 0;
	for (const match of source.matchAll(TAG)) {
		let start = match.index;
		let end = start + match[0].length;
		let line = false;
		if (!match[5]) {
			// A directive alone on its line takes the line with it.
			const lineStart = source.lastIndexOf("\n", start - 1) + 1;
			const lineEnd = source.indexOf("\n", end);
			const stop = lineEnd === -1 ? source.length : lineEnd;
			if (source.slice(lineStart, start).trim() === "" && source.slice(end, stop).trim() === "") {
				start = lineStart;
				end = lineEnd === -1 ? stop : lineEnd + 1;
				line = true;
			}
		}
		if (start > cursor) current().push(source.slice(cursor, start));
		cursor = end;
		if (match[5]) current().push({ variable: match[5] });
		else if (match[6]) current().push({ include: match[6], line });
		else if (match[1]) stack.push({ kind: match[1] as Frame["kind"], flag: match[2], ifTrue: [] });
		else if (match[3]) {
			const frame = stack.at(-1);
			if (!frame || frame.otherwise) throw new Error("Instruction template: unexpected {{else}}");
			frame.otherwise = [];
		} else {
			const frame = stack.pop();
			const closes = match[4] === "/if" ? "#if" : "#unless";
			if (!frame || frame.kind !== closes) throw new Error(`Instruction template: unexpected {{${match[4]}}}`);
			current().push({
				flag: frame.flag,
				negate: frame.kind === "#unless",
				ifTrue: frame.ifTrue,
				otherwise: frame.otherwise ?? [],
			});
		}
	}
	const open = stack.at(-1);
	if (open) throw new Error(`Instruction template: unclosed {{${open.kind} ${open.flag}}}`);
	if (cursor < source.length) root.push(source.slice(cursor));
	return root;
}

function lookup(values: TemplateValues, name: string): string | number | boolean | undefined {
	if (!Object.hasOwn(values, name)) throw new Error(`Instruction template: unknown name "${name}"`);
	return values[name];
}

function emit(nodes: Node[], values: TemplateValues): string {
	let text = "";
	for (const node of nodes) {
		if (typeof node === "string") text += node;
		else if ("variable" in node) text += String(lookup(values, node.variable) ?? "");
		else if ("include" in node) {
			const included = renderInstruction(node.include, values);
			text += included && node.line ? `${included}\n` : included;
		} else text += emit(Boolean(lookup(values, node.flag)) !== node.negate ? node.ifTrue : node.otherwise, values);
	}
	return text;
}

/** Render template text with the given values. */
export function renderTemplate(source: string, values: TemplateValues): string {
	const text = source.replace(WHOLE_LINE_COMMENT, "").replace(COMMENT, "");
	// Every line of a file ends with a newline; the last one is not part of the text. A value's own newlines stay.
	return emit(parse(text), values).replace(/\n$/, "");
}

let sources: Map<string, string> | undefined;

/**
 * Every instruction file, read together on first use (about 70 KB). A running process keeps the text it started with while the files change on disk, so its loaded code never
 * meets a template naming a value that code does not pass.
 */
function instructionSources(): Map<string, string> {
	if (sources) return sources;
	const root = getInstructionsDir();
	const read = new Map<string, string>();
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		const file = path.join(entry.parentPath, entry.name);
		const name = path.relative(root, file).split(path.sep).join("/");
		if (entry.isFile() && name.endsWith(".md")) read.set(name, fs.readFileSync(file, "utf8"));
	}
	sources = read;
	return read;
}

/** The text of an instruction file. `name` is relative to the instructions folder, such as `policy/work.md`. */
export function instructionSource(name: string): string {
	const text = instructionSources().get(name);
	if (text === undefined) throw new Error(`Instruction template: no file ${name} in ${getInstructionsDir()}`);
	return text;
}

/** Render an instruction file (`policy/work.md`) with the given values. */
export function renderInstruction(name: string, values: TemplateValues = {}): string {
	return renderTemplate(instructionSource(name), values);
}
