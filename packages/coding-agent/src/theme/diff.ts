import { backgroundAnsi, mixColors, visibleWidth } from "@octocodeai/octocode-tui";
import * as Diff from "diff";
import { replaceTabs } from "../core/tools/render-utils.ts";
import { isUnifiedDiff } from "../utils/code-sniff.ts";
import { getLanguageFromPath, highlightCode, theme } from "./theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

export interface RenderDiffOptions {
	/** File path, used to pick the syntax highlighting language. */
	filePath?: string;
}

/** Ends a tinted line: the terminal's default background. */
const DEFAULT_BG = "\x1b[49m";
/** How strongly a changed line, and a changed word inside it, are tinted toward the diff colour. */
const LINE_TINT = { dark: 0.16, light: 0.12 };
const WORD_TINT = { dark: 0.4, light: 0.3 };
/** A pair of lines whose unchanged text is less than this share of the longer line is a rewrite: no word emphasis. */
const MIN_SHARED_SHARE = 0.5;
/** Paired word emphasis only for blocks up to this many lines per side. */
const MAX_PAIRED_LINES = 8;

interface DiffTints {
	line: Record<"+" | "-", string>;
	word: Record<"+" | "-", string>;
}

/**
 * Background tints for changed lines, mixed from the theme's diff colours over the terminal background. Undefined for
 * themes that paint tool output on their own background (a nested background reset would cut that band) or whose
 * colours cannot be resolved; those keep the foreground-only rendering.
 */
function diffTints(): DiffTints | undefined {
	try {
		const mode = theme.getColorMode();
		// Tints are backgrounds: none without color.
		if (mode === "none") return undefined;
		if (theme.paintsBackground("toolSuccessBg") || theme.paintsBackground("toolPendingBg")) return undefined;
		const colors = theme.colors;
		const base = colors.toolSuccessBg;
		const added = colors.toolDiffAdded;
		const removed = colors.toolDiffRemoved;
		if (!base || !added || !removed) return undefined;
		const appearance = theme.appearance === "light" ? "light" : "dark";
		const tint = (color: typeof base, amount: number) => backgroundAnsi(mixColors(base, color, amount, "srgb"), mode);
		return {
			line: { "+": tint(added, LINE_TINT[appearance]), "-": tint(removed, LINE_TINT[appearance]) },
			word: { "+": tint(added, WORD_TINT[appearance]), "-": tint(removed, WORD_TINT[appearance]) },
		};
	} catch {
		return undefined;
	}
}

type Range = [start: number, end: number];

/** Character ranges of `oldContent` and `newContent` that a word diff marks changed, or undefined for a rewrite. */
function changedRanges(oldContent: string, newContent: string): { removed: Range[]; added: Range[] } | undefined {
	const removed: Range[] = [];
	const added: Range[] = [];
	let oldAt = 0;
	let newAt = 0;
	let shared = 0;
	// Word emphasis is optional; long rewritten lines must not hold up painting an otherwise complete diff.
	if (oldContent.length + newContent.length > 16 * 1024) return undefined;
	const changes = Diff.diffWordsWithSpace(oldContent, newContent, { timeout: 5, maxEditLength: 200 });
	if (!changes) return undefined;
	// With whitespace kept exact, an unchanged part has the same text, and length, on both sides.
	for (const part of changes) {
		const length = part.value.length;
		// Leading whitespace of a change is indentation, not part of the edit.
		const lead = part.value.match(/^\s*/)?.[0].length ?? 0;
		if (part.removed) {
			if (length > lead) removed.push([oldAt + lead, oldAt + length]);
			oldAt += length;
		} else if (part.added) {
			if (length > lead) added.push([newAt + lead, newAt + length]);
			newAt += length;
		} else {
			shared += part.value.trim().length;
			oldAt += length;
			newAt += length;
		}
	}
	const longer = Math.max(1, oldContent.trim().length, newContent.trim().length);
	return shared / longer < MIN_SHARED_SHARE ? undefined : { removed, added };
}

/**
 * Wraps the plain-text `ranges` of a styled line in `on` … `off`. Only SGR sequences are expected in `styled` (the
 * highlighter's output); they pass through without counting as characters.
 */
function overlayRanges(styled: string, ranges: Range[], on: string, off: string): string {
	if (ranges.length === 0) return styled;
	let out = "";
	let plain = 0;
	let next = 0;
	let inside = false;
	for (let i = 0; i < styled.length;) {
		if (styled[i] === "\x1b") {
			const end = styled.indexOf("m", i);
			if (end !== -1) {
				out += styled.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		const range = ranges[next];
		if (!inside && range && plain === range[0]) {
			out += on;
			inside = true;
		}
		const code = styled.codePointAt(i)!;
		const char = String.fromCodePoint(code);
		out += char;
		i += char.length;
		plain += char.length;
		if (inside && range && plain >= range[1]) {
			out += off;
			inside = false;
			next++;
		}
	}
	return inside ? out + off : out;
}

/** A run of consecutive diff lines the renderer treats together. */
type Segment =
	| { kind: "raw"; text: string; color?: "accent" | "muted"; file?: string }
	| { kind: "context"; rows: DiffRow[] }
	| { kind: "change"; removed: DiffRow[]; added: DiffRow[] };

interface DiffRow {
	lineNum: string;
	/** Content with tabs widened. */
	content: string;
}

/** SGR parameters that open or close one kind of style, so a style can be carried onto the next line. */
const SGR = /\x1b\[([0-9;]*)m/g;
const SGR_CLOSES: Record<string, string> = {
	"39": "fg",
	"49": "bg",
	"22": "weight",
	"23": "italic",
	"24": "underline",
	"27": "inverse",
	"29": "strike",
};

function sgrKind(first: number): string | undefined {
	if (first === 38 || (first >= 30 && first <= 37) || (first >= 90 && first <= 97)) return "fg";
	if (first === 48 || (first >= 40 && first <= 47) || (first >= 100 && first <= 107)) return "bg";
	if (first === 1 || first === 2) return "weight";
	if (first === 3) return "italic";
	if (first === 4) return "underline";
	if (first === 7) return "inverse";
	if (first === 9) return "strike";
	return undefined;
}

/**
 * Splits highlighted multi-line text so every line is self-contained: a style still open at the end of a line (a
 * comment or string spanning lines) is closed there and reopened at the start of the next.
 */
function carryStyles(lines: string[]): string[] {
	const open = new Map<string, string>();
	return lines.map((line) => {
		const prefix = [...open.values()].join("");
		for (const match of line.matchAll(SGR)) {
			const params = match[1] || "0";
			if (params === "0") open.clear();
			else if (SGR_CLOSES[params]) open.delete(SGR_CLOSES[params]);
			else {
				const kind = sgrKind(Number(params.split(";")[0]));
				if (kind) open.set(kind, match[0]);
			}
		}
		return `${prefix}${line}${open.size > 0 ? "\x1b[0m" : ""}`;
	});
}

/** Highlights the rows as one text, so multi-line comments and strings keep their state, one line per row. */
function highlightRows(rows: DiffRow[], language: string | undefined): string[] | undefined {
	if (!language || rows.length === 0) return undefined;
	const lines = highlightCode(rows.map((row) => row.content).join("\n"), language);
	return lines.length === rows.length ? carryStyles(lines) : undefined;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray, with dimmed syntax colour when the file's language is known
 * - Removed lines: red sign, syntax-coloured text, with changed words emphasized
 * - Added lines: green sign, syntax-coloured text, with changed words emphasized
 *
 * Each side of a change block is highlighted as one text, so a comment or string spanning lines colours every line.
 * On themes without tool backgrounds, changed lines get a tinted background and a stronger tint on changed words;
 * otherwise the changed words are inverted. Without a known language the text takes the diff colour.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const tints = diffTints();
	// A unified diff (`git diff`'s text) has no line numbers, and names each file in its head.
	const unified = isUnifiedDiff(diffText);
	let language = options.filePath ? getLanguageFromPath(options.filePath) : undefined;
	const wordOn = (sign: "+" | "-") => tints?.word[sign] ?? "\x1b[7m";
	const wordOff = (sign: "+" | "-") => tints?.line[sign] ?? "\x1b[27m";
	const changedLine = (sign: "+" | "-", row: DiffRow, highlighted?: string, ranges: Range[] = []): string => {
		const color = sign === "+" ? "toolDiffAdded" : "toolDiffRemoved";
		const body = highlighted ?? theme.fg(color, row.content);
		const marked = overlayRanges(body, ranges, wordOn(sign), wordOff(sign));
		const label = theme.fg(color, unified ? sign : `${sign}${row.lineNum} `);
		if (!tints) return `${label}${marked}`;
		// The sign and number carry the colour; the tint marks the whole changed line, so a line of only whitespace
		// still shows as changed.
		const text = visibleWidth(row.content) === 0 ? " " : marked;
		return `${label}${tints.line[sign]}${text}${DEFAULT_BG}`;
	};
	const out: string[] = [];
	for (const segment of unified ? parseUnified(diffText) : parseSegments(diffText)) {
		if (segment.kind === "raw") {
			if (segment.file && !options.filePath) language = getLanguageFromPath(segment.file);
			out.push(theme.fg(segment.color ?? "toolDiffContext", segment.text));
		} else if (segment.kind === "context") {
			const highlighted = highlightRows(segment.rows, language);
			segment.rows.forEach((row, index) => {
				out.push(
					highlighted
						? `${theme.fg("toolDiffContext", unified ? " " : ` ${row.lineNum} `)}\x1b[2m${highlighted[index]}\x1b[22m`
						: theme.fg("toolDiffContext", unified ? ` ${row.content}` : ` ${row.lineNum} ${row.content}`),
				);
			});
		} else {
			const { removed, added } = segment;
			// Lines replaced one for one are paired, so each pair can show which words changed.
			const paired = removed.length === added.length && removed.length <= MAX_PAIRED_LINES;
			const ranges = paired ? removed.map((row, index) => changedRanges(row.content, added[index].content)) : [];
			const removedHl = highlightRows(removed, language);
			const addedHl = highlightRows(added, language);
			removed.forEach((row, i) => out.push(changedLine("-", row, removedHl?.[i], ranges[i]?.removed)));
			added.forEach((row, i) => out.push(changedLine("+", row, addedHl?.[i], ranges[i]?.added)));
		}
	}
	return out.join("\n");
}

/** Groups a diff into raw lines, runs of context rows and change blocks (the removed rows and the added rows after them). */
function parseSegments(diffText: string): Segment[] {
	const lines = diffText.split("\n");
	const segments: Segment[] = [];
	let i = 0;
	const collect = (prefix: "-" | "+"): DiffRow[] => {
		const rows: DiffRow[] = [];
		while (i < lines.length) {
			const parsed = parseDiffLine(lines[i]);
			if (!parsed || parsed.prefix !== prefix) break;
			rows.push({ lineNum: parsed.lineNum, content: replaceTabs(parsed.content) });
			i++;
		}
		return rows;
	};
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]);
		const last = segments[segments.length - 1];
		if (!parsed) {
			segments.push({ kind: "raw", text: lines[i] });
			i++;
		} else if (parsed.prefix !== "-" && parsed.prefix !== "+") {
			const row = { lineNum: parsed.lineNum, content: replaceTabs(parsed.content) };
			// A row without a line number is the "..." gap marker: it ends the run, so code on either side is not joined.
			if (last?.kind === "context" && parsed.lineNum.trim() !== "" && last.rows.at(-1)?.lineNum.trim() !== "")
				last.rows.push(row);
			else segments.push({ kind: "context", rows: [row] });
			i++;
		} else {
			const removed = collect("-");
			segments.push({ kind: "change", removed, added: collect("+") });
		}
	}
	return segments;
}

/** The file a `diff --git a/x b/x` or `+++ b/x` head names: its new path, without the `a/`/`b/` prefix or a trailing tab. */
function headFile(line: string): string | undefined {
	const path = (/^\+\+\+ (\S.*?)\t?$/.exec(line)?.[1] ?? / b\/(.+)$/.exec(line)?.[1])?.replace(/^b\//, "");
	return path && path !== "/dev/null" ? path : undefined;
}

/** Groups a unified diff (`@@` hunks, `+`/`-`/space lines) like `parseSegments`; heads and `\ No newline` lines stay raw. */
function parseUnified(diffText: string): Segment[] {
	const lines = diffText.split("\n");
	const segments: Segment[] = [];
	let inHunk = false;
	let i = 0;
	const run = (sign: string): DiffRow[] => {
		const rows: DiffRow[] = [];
		while (i < lines.length && lines[i].startsWith(sign))
			rows.push({ lineNum: "", content: replaceTabs(lines[i++].slice(1)) });
		return rows;
	};
	while (i < lines.length) {
		const line = lines[i];
		if (line.startsWith("@@")) {
			inHunk = true;
			segments.push({ kind: "raw", text: line, color: "accent" });
			i++;
		} else if (line.startsWith("diff --git ")) {
			inHunk = false;
			const file = headFile(line);
			segments.push({ kind: "raw", text: line, color: "accent", ...(file ? { file } : {}) });
			i++;
		} else if (!inHunk || !/^[-+ ]/.test(line)) {
			const file = line.startsWith("+++ ") ? headFile(line) : undefined;
			segments.push({ kind: "raw", text: line, color: "muted", ...(file ? { file } : {}) });
			i++;
		} else if (line.startsWith(" ")) {
			segments.push({ kind: "context", rows: run(" ") });
		} else {
			const removed = run("-");
			segments.push({ kind: "change", removed, added: run("+") });
		}
	}
	return segments;
}
