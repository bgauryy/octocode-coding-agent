import type { Tokens } from "marked";
import { wrapTextWithAnsi } from "../../utils/wrap.ts";
import { visibleWidth } from "../../utils/width.ts";
import { renderInlineTokens } from "./inline.ts";
import type { InlineStyleContext, MarkdownRenderHost } from "./types.ts";

/** A word up to this wide never breaks while the columns fit; longer ones (URLs, paths) wrap inside their cell. */
const MAX_UNBROKEN_WORD_WIDTH = 30;
/** Continuation rows of a stacked record start this far in, under the value rather than the header. */
const STACKED_INDENT = 2;

/**
 * Get the visible width of the longest word in a string.
 */
function getLongestWordWidth(text: string, maxWidth?: number): number {
	const words = text.split(/\s+/).filter((word) => word.length > 0);
	let longest = 0;
	for (const word of words) {
		longest = Math.max(longest, visibleWidth(word));
	}
	if (maxWidth === undefined) {
		return longest;
	}
	return Math.min(longest, maxWidth);
}

/**
 * Wrap a table cell to fit into a column.
 *
 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
 * consistently with the rest of the renderer.
 */
function wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
	const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
	return lines.map((line, index) => {
		// Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
		const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
		return `${line}${styleReset}${stylePrefix}`;
	});
}

/**
 * Shares the spare columns. Each column starts at its longest word. A column whose remaining need fits an equal share of
 * the spare takes it whole, again until none does, so short columns (states, names, counts) never wrap beside prose.
 * The long columns then split the rest in proportion to what each still needs.
 */
function waterFill(minWidths: number[], naturalWidths: number[], available: number): number[] {
	const widths = [...minWidths];
	const need = (i: number) => naturalWidths[i] - widths[i];
	let spare = available - widths.reduce((a, b) => a + b, 0);
	let hungry = widths.map((_, i) => i).filter((i) => need(i) > 0);
	for (;;) {
		const share = spare / hungry.length;
		const small = hungry.filter((i) => need(i) <= share);
		if (small.length === 0) break;
		for (const i of small) {
			spare -= need(i);
			widths[i] = naturalWidths[i];
		}
		hungry = hungry.filter((i) => need(i) > 0);
	}
	const totalNeed = hungry.reduce((total, i) => total + need(i), 0);
	const grown = hungry.map((i) => Math.floor((need(i) / totalNeed) * spare));
	hungry.forEach((i, k) => {
		widths[i] += grown[k];
	});
	// Rounding leftovers go to the columns closest to fitting whole.
	let leftover = spare - grown.reduce((a, b) => a + b, 0);
	for (const i of [...hungry].sort((a, b) => need(a) - need(b))) {
		if (leftover <= 0) break;
		widths[i]++;
		leftover--;
	}
	return widths;
}

/**
 * Render a table with width-aware cell wrapping.
 * Cells that don't fit are wrapped to multiple lines. When the columns cannot fit side by side without breaking words,
 * each row becomes a record of `Header: value` lines instead.
 */
export function renderTable(
	host: MarkdownRenderHost,
	token: Tokens.Table,
	availableWidth: number,
	nextTokenType?: string,
	styleContext?: InlineStyleContext,
): string[] {
	const numCols = token.header.length;

	if (numCols === 0) {
		return [];
	}

	// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
	// = 2 + (n-1) * 3 + 2 = 3n + 1
	const borderOverhead = 3 * numCols + 1;
	const availableForCells = availableWidth - borderOverhead;

	// Calculate natural column widths (what each column needs without constraints)
	const naturalWidths: number[] = [];
	const minWordWidths: number[] = [];
	for (let i = 0; i < numCols; i++) {
		const headerText = renderInlineTokens(host, token.header[i].tokens || [], styleContext);
		naturalWidths[i] = visibleWidth(headerText);
		minWordWidths[i] = Math.max(1, getLongestWordWidth(headerText, MAX_UNBROKEN_WORD_WIDTH));
	}
	for (const row of token.rows) {
		for (let i = 0; i < row.length; i++) {
			const cellText = renderInlineTokens(host, row[i].tokens || [], styleContext);
			naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
			minWordWidths[i] = Math.max(minWordWidths[i] || 1, getLongestWordWidth(cellText, MAX_UNBROKEN_WORD_WIDTH));
		}
	}

	const minCellsWidth = minWordWidths.reduce((a, b) => a + b, 0);
	if (minCellsWidth > availableForCells && numCols > 1 && availableWidth > STACKED_INDENT) {
		return renderStacked(host, token, availableWidth, nextTokenType, styleContext);
	}
	if (availableForCells < numCols) {
		// Too narrow to render a stable table. Fall back to raw markdown.
		const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
		if (nextTokenType && nextTokenType !== "space") {
			fallbackLines.push("");
		}
		return fallbackLines;
	}

	// A single column narrower than its longest word breaks that word; it has nowhere else to go.
	const minColumnWidths = minCellsWidth > availableForCells ? [availableForCells] : minWordWidths;
	const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
	const columnWidths =
		totalNaturalWidth <= availableWidth ? naturalWidths : waterFill(minColumnWidths, naturalWidths, availableForCells);
	return drawTable(host, token, columnWidths, nextTokenType, styleContext);
}

/**
 * One record per row: `Header: value`, the value wrapping under a short indent, records split by a rule. Used where a
 * grid would break words into a column of letters.
 */
function renderStacked(
	host: MarkdownRenderHost,
	token: Tokens.Table,
	availableWidth: number,
	nextTokenType?: string,
	styleContext?: InlineStyleContext,
): string[] {
	const headers = token.header.map((cell) => renderInlineTokens(host, cell.tokens || [], styleContext));
	const rule = host.theme.hr("─".repeat(Math.min(availableWidth, 40)));
	const indent = " ".repeat(STACKED_INDENT);
	const lines: string[] = [];
	token.rows.forEach((row, rowIndex) => {
		if (rowIndex > 0) lines.push(rule);
		row.forEach((cell, i) => {
			const value = renderInlineTokens(host, cell.tokens || [], styleContext);
			const record = `${host.theme.bold(`${headers[i] ?? ""}:`)} ${value}`;
			// Wrapped at the indented width, so the first row and the indented continuation rows both fit.
			const wrapped = wrapCellText(record, availableWidth - STACKED_INDENT, styleContext?.stylePrefix);
			wrapped.forEach((line, index) => lines.push(index === 0 ? line : `${indent}${line}`));
		});
	});
	if (nextTokenType && nextTokenType !== "space") {
		lines.push("");
	}
	return lines;
}

function drawTable(
	host: MarkdownRenderHost,
	token: Tokens.Table,
	columnWidths: number[],
	nextTokenType?: string,
	styleContext?: InlineStyleContext,
): string[] {
	const lines: string[] = [];
	const topBorderCells = columnWidths.map((w) => "─".repeat(w));
	lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

	const headerCellLines: string[][] = token.header.map((cell, i) => {
		const text = renderInlineTokens(host, cell.tokens || [], styleContext);
		return wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
	});
	const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

	for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
		const rowParts = headerCellLines.map((cellLines, colIdx) => {
			const text = cellLines[lineIdx] || "";
			const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
			return host.theme.bold(padded);
		});
		lines.push(`│ ${rowParts.join(" │ ")} │`);
	}

	const separatorCells = columnWidths.map((w) => "─".repeat(w));
	const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
	lines.push(separatorLine);

	const rowsCellLines: string[][][] = token.rows.map((row) =>
		row.map((cell, i) => {
			const text = renderInlineTokens(host, cell.tokens || [], styleContext);
			return wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		}),
	);
	// Rules between rows are only needed to tell wrapped rows apart; single-line rows read better without them.
	const separateRows = rowsCellLines.some((cells) => cells.some((cellLines) => cellLines.length > 1));
	for (let rowIndex = 0; rowIndex < rowsCellLines.length; rowIndex++) {
		const rowCellLines = rowsCellLines[rowIndex];
		const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
			const rowParts = rowCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		if (separateRows && rowIndex < rowsCellLines.length - 1) {
			lines.push(separatorLine);
		}
	}

	const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
	lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

	if (nextTokenType && nextTokenType !== "space") {
		lines.push(""); // Add spacing after table
	}
	return lines;
}
