import { backgroundAnsi, mixColors, visibleWidth } from "@octocodeai/octocode-tui";
import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path, used to pick the syntax highlighting language. */
	filePath?: string;
}

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
		if (theme.getBgAnsi("toolSuccessBg") !== DEFAULT_BG || theme.getBgAnsi("toolPendingBg") !== DEFAULT_BG)
			return undefined;
		const colors = theme.colors;
		const base = colors.toolSuccessBg;
		const added = colors.toolDiffAdded;
		const removed = colors.toolDiffRemoved;
		if (!base || !added || !removed) return undefined;
		const appearance = theme.appearance === "light" ? "light" : "dark";
		const mode = theme.getColorMode();
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
	// With whitespace kept exact, an unchanged part has the same text, and length, on both sides.
	for (const part of Diff.diffWordsWithSpace(oldContent, newContent)) {
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

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with changed tokens emphasized
 * - Added lines: green, with changed tokens emphasized
 *
 * On themes without tool backgrounds, changed lines get a tinted background, syntax-highlighted content (when the
 * file's language is known) and a stronger tint on changed words; otherwise the whole line takes the diff colour and
 * changed words are inverted.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const tints = diffTints();
	if (!tints) return renderBlocks(diffText, plainChange);
	const language = options.filePath ? getLanguageFromPath(options.filePath) : undefined;
	const changedLine = (sign: "+" | "-", row: DiffRow, ranges: Range[] = []): string => {
		const color = sign === "+" ? "toolDiffAdded" : "toolDiffRemoved";
		const body = language ? (highlightCode(row.content, language)[0] ?? row.content) : theme.fg(color, row.content);
		const marked = overlayRanges(body, ranges, tints.word[sign], tints.line[sign]);
		// The sign and number carry the colour; the tint marks the whole changed line, so a line of only whitespace
		// still shows as changed.
		const text = visibleWidth(row.content) === 0 ? " " : marked;
		return `${theme.fg(color, `${sign}${row.lineNum} `)}${tints.line[sign]}${text}${DEFAULT_BG}`;
	};
	return renderBlocks(diffText, (removed, added) => {
		// Lines replaced one for one are paired, so each pair can show which words changed.
		const paired = removed.length === added.length && removed.length <= MAX_PAIRED_LINES;
		const ranges = paired ? removed.map((row, index) => changedRanges(row.content, added[index].content)) : [];
		return [
			...removed.map((row, index) => changedLine("-", row, ranges[index]?.removed)),
			...added.map((row, index) => changedLine("+", row, ranges[index]?.added)),
		];
	});
}

/** The foreground-only rendering of a change block, for themes that draw tool output on their own background. */
function plainChange(removed: DiffRow[], added: DiffRow[]): string[] {
	// Only do intra-line diffing for a single line modification. Otherwise, show lines as-is.
	if (removed.length === 1 && added.length === 1) {
		const { removedLine, addedLine } = renderIntraLineDiff(removed[0].content, added[0].content);
		return [
			theme.fg("toolDiffRemoved", `-${removed[0].lineNum} ${removedLine}`),
			theme.fg("toolDiffAdded", `+${added[0].lineNum} ${addedLine}`),
		];
	}
	return [
		...removed.map((row) => theme.fg("toolDiffRemoved", `-${row.lineNum} ${row.content}`)),
		...added.map((row) => theme.fg("toolDiffAdded", `+${row.lineNum} ${row.content}`)),
	];
}

interface DiffRow {
	lineNum: string;
	/** Content with tabs widened. */
	content: string;
}

/**
 * Walks a diff: context lines (and lines that are not diff rows) are drawn dim; each change block, the removed lines
 * and the added lines that follow them, goes to `change`.
 */
function renderBlocks(diffText: string, change: (removed: DiffRow[], added: DiffRow[]) => string[]): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
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
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", lines[i]));
			i++;
		} else if (parsed.prefix !== "-" && parsed.prefix !== "+") {
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			const removed = collect("-");
			result.push(...change(removed, collect("+")));
		}
	}
	return result.join("\n");
}
