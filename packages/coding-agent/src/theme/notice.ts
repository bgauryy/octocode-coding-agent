/**
 * Semantic notices: a command says what it found as a title, label/value rows, warnings and a hint line, and the
 * terminal colors each part by its role (labels, paths, ids, warnings) with theme tokens. The text stays plain: the
 * same notice reads the same in print mode, RPC and a log; only the interactive status line paints it.
 */

import { theme } from "./theme.ts";

export interface Notice {
	title: string;
	rows?: ReadonlyArray<readonly [label: string, value: string]>;
	warnings?: readonly string[];
	/** What to do next, such as the command that shows more. */
	hint?: string;
}

/** The plain text of a notice; `styleNoticeWith` recognizes its parts again. */
export function noticeText({ title, rows = [], warnings = [], hint }: Notice): string {
	const width = Math.max(0, ...rows.map(([label]) => label.length));
	return [
		`${title}:`,
		...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
		...warnings.map((warning) => `  ⚠ ${warning}`),
		...(hint ? [`→ ${hint}`] : []),
	].join("\n");
}

export type NoticeRole = "text" | "title" | "label" | "path" | "id" | "warning" | "hint";
export type Paint = (role: NoticeRole, text: string) => string;

const PATH = /(?<![\w/])(?:~|\.{1,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]*)*/g;
const ID = /(?<![\w/])(?:#\d+|[A-Z]{1,3}\d{1,6}|pid \d+)(?![\w/])/g;
const ROW = /^(\s*)([A-Za-z][\w ./-]{0,30}?)(:|\s{2,})(?=\S|$)/;

function paintValue(text: string, paint: Paint): string {
	const spans: Array<{ at: number; end: number; role: NoticeRole }> = [];
	for (const [pattern, role] of [
		[ID, "id"],
		[PATH, "path"],
	] as const)
		for (const match of text.matchAll(pattern))
			spans.push({ at: match.index, end: match.index + match[0].length, role });
	spans.sort((a, b) => a.at - b.at);
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.at < cursor) continue;
		out += paint("text", text.slice(cursor, span.at)) + paint(span.role, text.slice(span.at, span.end));
		cursor = span.end;
	}
	return out + paint("text", text.slice(cursor));
}

/** Paints command text line by line with `paint`; text carrying escape codes (links) is left as it is. */
export function styleNoticeWith(text: string, paint: Paint): string {
	if (text.includes("\x1b")) return text;
	const lines = text.split("\n");
	return lines
		.map((line, index) => {
			if (line === "") return line;
			if (/^\s*(⚠|Usage:|Warning:|Error:)/.test(line)) return paint("warning", line);
			if (line.startsWith("→ ")) return paint("hint", line);
			if (index === 0 && lines.length > 1 && line.endsWith(":")) return paint("title", line);
			const row = ROW.exec(line);
			if (row && (index > 0 || lines.length === 1 || line.endsWith(":"))) {
				const [whole, indent, label, separator] = row;
				const painted = paint("label", label);
				const gap = separator === ":" ? paint("text", ":") : separator;
				return indent + painted + gap + paintValue(line.slice(whole.length), paint);
			}
			return paintValue(line, paint);
		})
		.join("\n");
}

const TOKENS: Record<NoticeRole, Parameters<typeof theme.fg>[0]> = {
	text: "dim",
	title: "accent",
	label: "muted",
	path: "accent",
	id: "accent",
	warning: "warning",
	hint: "muted",
};

/** `styleNoticeWith` in the active theme's colors. */
export function styleNotice(text: string): string {
	return styleNoticeWith(text, (role, part) => (part ? theme.fg(TOKENS[role], part) : part));
}
