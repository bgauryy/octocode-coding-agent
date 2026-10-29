/** Size tables for `mcp compact check`: what a set of description overrides saves in the rendered file. */

import type { CompactServerInput, DescriptionOverrides } from "../compact/index.ts";

interface DocRow {
	copies: number;
	fields: Set<string>;
	shared: boolean;
}

interface ProseStats {
	server: number;
	tools: number;
	fields: number;
	prose: number;
	structure: number;
	docs: Map<string, DocRow>;
}

const NOTE_TAIL =
	/\s*\((?:format|pattern|minLength|maxLength|minimum|maximum|exclusive|multipleOf|minItems|maxItems|uniqueItems|minProperties|maxProperties|default|e\.g\.)[^]*\)$/;
const stripNote = (doc: string) => doc.replace(NOTE_TAIL, "");

/**
 * Splits a rendered file into prose (server instructions, tool descriptions, field docs without their trailing
 * constraint note) and structure (signatures, constraint notes, header). `docs` groups field docs by text: a doc's
 * cost is its length times its copies, and a shared doc counts once.
 */
function proseStats(text: string): ProseStats {
	const stats: ProseStats = { server: 0, tools: 0, fields: 0, prose: 0, structure: 0, docs: new Map() };
	const addField = (name: string, doc: string, shared: boolean) => {
		const prose = stripNote(doc);
		if (!prose) return;
		stats.fields += prose.length;
		const row = stats.docs.get(prose) ?? { copies: 0, fields: new Set<string>(), shared: false };
		row.copies += 1;
		row.fields.add(name);
		row.shared ||= shared;
		stats.docs.set(prose, row);
	};
	let inShared = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("\t/** Fields documented once")) inShared = true;
		else if (inShared && line === "\t */") inShared = false;
		else if (inShared) {
			const match = /^\t \* ([^:]+): (.*)$/.exec(line);
			if (match) addField(match[1], match[2], true);
		} else if (line.startsWith("/** ") && line.endsWith(" */")) stats.server += line.length - 7;
		else if (/^\t\/\*\* .* \*\/$/.test(line)) stats.tools += line.length - 8;
		else if (line.startsWith("\t\t"))
			for (const match of line.matchAll(/\/\*\* (.+?) \*\/ ([\w$"]+)\??:/g))
				addField(match[2].replaceAll('"', ""), match[1], false);
	}
	stats.prose = stats.server + stats.tools + stats.fields;
	stats.structure = text.length - stats.prose;
	return stats;
}

const change = (before: number, after: number) =>
	before === 0 ? "" : `${Math.round(((after - before) / before) * 100)}%`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function docTable(title: string, stats: ProseStats, top: number): string[] {
	const rows = [...stats.docs]
		.map(([doc, row]) => ({ doc, ...row, chars: doc.length * row.copies }))
		.sort((a, b) => b.chars - a.chars)
		.slice(0, top);
	return [
		`| ${title} | Copies | Chars | Fields |`,
		"|---|---:|---:|---|",
		...rows.map((row) => {
			const names = [...row.fields];
			const shown = `${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}`;
			return `| ${clip(row.doc, 70)}${row.shared ? " (shared)" : ""} | ${row.copies} | ${row.chars} | ${shown} |`;
		}),
	];
}

/** Before/after description sizes for the server instructions and each tool. */
function descriptionTable(input: CompactServerInput, overrides: DescriptionOverrides): string[] {
	const rows: [string, number, number][] = [
		["(server instructions)", (input.instructions ?? "").length, (overrides.server ?? input.instructions ?? "").length],
	];
	for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name)))
		rows.push([
			tool.name,
			(tool.description ?? "").length,
			(overrides.tools?.[tool.name] ?? tool.description ?? "").length,
		]);
	rows.push(["total", rows.reduce((sum, row) => sum + row[1], 0), rows.reduce((sum, row) => sum + row[2], 0)]);
	return [
		"| Description | Before | After | Change |",
		"|---|---:|---:|---:|",
		...rows.map(([name, before, after]) => `| ${name} | ${before} | ${after} | ${change(before, after)} |`),
	];
}

/**
 * Markdown tables: whole-file size, prose against structure, the field docs that cost the most characters, and each
 * description. `plain` is the file rendered without overrides, `text` the file rendered with them.
 */
export function sizeReport(
	input: CompactServerInput,
	overrides: DescriptionOverrides,
	plain: string,
	text: string,
): string {
	const before = proseStats(plain);
	const after = proseStats(text);
	const row = (name: string, a: number, b: number) => `| ${name} | ${a} | ${b} | ${change(a, b)} |`;
	return [
		"| Measure | Before | After | Change |",
		"|---|---:|---:|---:|",
		row("rendered file", plain.length, text.length),
		row("prose (instructions + tool + field docs)", before.prose, after.prose),
		row("  server instructions", before.server, after.server),
		row("  tool descriptions", before.tools, after.tools),
		row("  field docs", before.fields, after.fields),
		row("structure (types, constraint notes, header)", before.structure, after.structure),
		"",
		...docTable("Costliest field docs before (length x copies)", before, 8),
		"",
		...docTable("Costliest field docs after", after, 4),
		"",
		...descriptionTable(input, overrides),
		"",
		`rendered file ${plain.length} -> ${text.length} chars; prose ${before.prose} -> ${after.prose} (${change(before.prose, after.prose)})`,
	].join("\n");
}
