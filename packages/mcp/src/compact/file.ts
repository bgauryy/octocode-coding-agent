import { dedupeFieldDocs } from "./field-docs.ts";

/**
 * The generated file as text: the head (instructions, shared docs, shared types) and the tool blocks, with the parts
 * that cut one tool or a set of tools out of it.
 */

export const INDENT = "\t";
const SHARED_HEAD = `${INDENT}/** Fields documented once; the doc applies wherever the field appears:`;
const HOISTED_HEAD = `${INDENT}// Types used more than once:`;

export const indentBlock = (text: string, indent: string) =>
	text
		.split("\n")
		.map((line) => (line ? indent + line : line))
		.join("\n");

export const hoistedBlock = (entries: Iterable<[string, string]>) =>
	`${HOISTED_HEAD}\n${[...entries].map(([name, type]) => `${dedupeFieldDocs(indentBlock(`type ${name} = ${type};`, INDENT))}\n`).join("")}`;

const sharedLine = (field: string, doc: string) => `${INDENT} * ${field}: ${doc}`;
export const sharedBlock = (entries: Iterable<[string, string]>) =>
	`${SHARED_HEAD}\n${[...entries].map(([field, doc]) => sharedLine(field, doc)).join("\n")}\n${INDENT} */\n`;

interface ParsedFile {
	lines: string[];
	/** Index of the first line after the header (instructions, shared docs, shared types). */
	bodyStart: number;
	shared: Map<string, string>;
	/** Server-level alias name → its line range. */
	types: Map<string, [number, number]>;
	blocks: Map<string, [number, number]>;
}

const isToolLevel = (line: string) => line.startsWith(INDENT) && !line.startsWith(INDENT + INDENT);

function parse(text: string): ParsedFile {
	const lines = text.split("\n");
	const shared = new Map<string, string>();
	const blocks = new Map<string, [number, number]>();
	let index = lines.findIndex((line) => line.startsWith("declare namespace ")) + 1;
	if (lines[index] === SHARED_HEAD) {
		for (index++; index < lines.length && lines[index] !== `${INDENT} */`; index++) {
			const match = /^\t \* ([^:]+): (.*)$/.exec(lines[index]);
			if (match) shared.set(match[1], match[2]);
		}
		index++;
	}
	const types = new Map<string, [number, number]>();
	if (lines[index] === HOISTED_HEAD) {
		for (index++; index < lines.length; index++) {
			const match = /^\ttype ([\w$]+) = /.exec(lines[index]);
			if (!match) break;
			let end = index;
			while (end < lines.length && !(isToolLevel(lines[end]) && lines[end].endsWith(";"))) end++;
			types.set(match[1], [index, end]);
			index = end;
		}
	}
	const bodyStart = index;
	let start = -1;
	for (; index < lines.length; index++) {
		const line = lines[index];
		if (start < 0 && isToolLevel(line)) start = index;
		const match = /^\tfunction ([\w$]+)\(/.exec(line);
		if (!match) continue;
		let end = index;
		while (end < lines.length && !(isToolLevel(lines[end]) && lines[end].endsWith(";"))) end++;
		blocks.set(match[1], [start, end]);
		start = -1;
		index = end;
	}
	return { lines, bodyStart, shared, types, blocks };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One tool's block (aliases, JSDoc, function) from a rendered file, with the shared docs of the fields it uses, for
 * showing the tool without the rest of the file (a refused call). `fn` is the tool's function name
 * (`functionNames`). Undefined when the file lacks it.
 */
export function toolBlock(text: string, fn: string): string | undefined {
	const file = parse(text);
	const range = file.blocks.get(fn);
	if (!range) return undefined;
	const own = file.lines.slice(range[0], range[1] + 1).join("\n");
	const typeLines = [...file.types]
		.filter(([name]) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(own))
		.flatMap(([, [start, end]]) => file.lines.slice(start, end + 1));
	const body = typeLines.length ? `${HOISTED_HEAD}\n${typeLines.join("\n")}\n${own}` : own;
	const used = [...file.shared].filter(([field]) =>
		new RegExp(`(^|[\\s{;/])"?${escapeRegExp(field)}"?\\??:`, "m").test(body),
	);
	return used.length ? `${sharedBlock(used)}${body}` : body;
}

/** The hoisted types the text names, and those they name, as file line ranges in file order. */
function typesUsedBy(file: ParsedFile, text: string): [number, number][] {
	const kept = new Set<string>();
	let scope = text;
	for (let grew = true; grew;) {
		grew = false;
		for (const [name, [start, end]] of file.types) {
			if (kept.has(name) || !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(scope)) continue;
			kept.add(name);
			scope += `\n${file.lines.slice(start, end + 1).join("\n")}`;
			grew = true;
		}
	}
	return [...file.types].filter(([name]) => kept.has(name)).map(([, range]) => range);
}

/**
 * The rendered file restricted to the named functions (`functionNames`), e.g. the tools one agent declares: the
 * header and instructions are kept, the shared docs and types only where a kept tool uses them.
 */
export function selectTools(text: string, fns: readonly string[]): string {
	const file = parse(text);
	const keep = new Set(fns);
	const head = file.lines.slice(0, file.lines.findIndex((line) => line.startsWith("declare namespace ")) + 1);
	const body = [...file.blocks]
		.filter(([name]) => keep.has(name))
		.flatMap(([, [start, end]]) => file.lines.slice(start, end + 1));
	const typeLines = typesUsedBy(file, body.join("\n")).flatMap(([start, end]) => file.lines.slice(start, end + 1));
	const scope = [...body, ...typeLines].join("\n");
	const used = [...file.shared].filter(([field]) =>
		new RegExp(`(^|[\\s{;/])"?${escapeRegExp(field)}"?\\??:`, "m").test(scope),
	);
	return [
		...head,
		...(used.length ? [sharedBlock(used).trimEnd()] : []),
		...(typeLines.length ? [HOISTED_HEAD, ...typeLines] : []),
		...body,
		"}",
		"",
	].join("\n");
}
