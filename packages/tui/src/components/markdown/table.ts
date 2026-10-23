import type { Tokens } from "marked";
import { visibleWidth, wrapTextWithAnsi } from "../../utils.ts";
import { renderInlineTokens } from "./inline.ts";
import type { InlineStyleContext, MarkdownRenderHost } from "./types.ts";

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
 * Render a table with width-aware cell wrapping.
 * Cells that don't fit are wrapped to multiple lines.
 */
export function renderTable(
	host: MarkdownRenderHost,
	token: Tokens.Table,
	availableWidth: number,
	nextTokenType?: string,
	styleContext?: InlineStyleContext,
): string[] {
	const lines: string[] = [];
	const numCols = token.header.length;

	if (numCols === 0) {
		return lines;
	}

	// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
	// = 2 + (n-1) * 3 + 2 = 3n + 1
	const borderOverhead = 3 * numCols + 1;
	const availableForCells = availableWidth - borderOverhead;
	if (availableForCells < numCols) {
		// Too narrow to render a stable table. Fall back to raw markdown.
		const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
		if (nextTokenType && nextTokenType !== "space") {
			fallbackLines.push("");
		}
		return fallbackLines;
	}

	const maxUnbrokenWordWidth = 30;

	// Calculate natural column widths (what each column needs without constraints)
	const naturalWidths: number[] = [];
	const minWordWidths: number[] = [];
	for (let i = 0; i < numCols; i++) {
		const headerText = renderInlineTokens(host, token.header[i].tokens || [], styleContext);
		naturalWidths[i] = visibleWidth(headerText);
		minWordWidths[i] = Math.max(1, getLongestWordWidth(headerText, maxUnbrokenWordWidth));
	}
	for (const row of token.rows) {
		for (let i = 0; i < row.length; i++) {
			const cellText = renderInlineTokens(host, row[i].tokens || [], styleContext);
			naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
			minWordWidths[i] = Math.max(minWordWidths[i] || 1, getLongestWordWidth(cellText, maxUnbrokenWordWidth));
		}
	}

	let minColumnWidths = minWordWidths;
	let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

	if (minCellsWidth > availableForCells) {
		minColumnWidths = Array.from({ length: numCols }, () => 1);
		const remaining = availableForCells - numCols;

		if (remaining > 0) {
			const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
			const growth = minWordWidths.map((width) => {
				const weight = Math.max(0, width - 1);
				return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
			});

			for (let i = 0; i < numCols; i++) {
				minColumnWidths[i] += growth[i] ?? 0;
			}

			const allocated = growth.reduce((total, width) => total + width, 0);
			let leftover = remaining - allocated;
			for (let i = 0; leftover > 0 && i < numCols; i++) {
				minColumnWidths[i]++;
				leftover--;
			}
		}

		minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
	}

	// Calculate column widths that fit within available width
	const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
	let columnWidths: number[];

	if (totalNaturalWidth <= availableWidth) {
		// Everything fits naturally
		columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
	} else {
		// Need to shrink columns to fit
		const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
			return total + Math.max(0, width - minColumnWidths[index]);
		}, 0);
		const extraWidth = Math.max(0, availableForCells - minCellsWidth);
		columnWidths = minColumnWidths.map((minWidth, index) => {
			const naturalWidth = naturalWidths[index];
			const minWidthDelta = Math.max(0, naturalWidth - minWidth);
			let grow = 0;
			if (totalGrowPotential > 0) {
				grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
			}
			return minWidth + grow;
		});

		// Adjust for rounding errors - distribute remaining space
		const allocated = columnWidths.reduce((a, b) => a + b, 0);
		let remaining = availableForCells - allocated;
		while (remaining > 0) {
			let grew = false;
			for (let i = 0; i < numCols && remaining > 0; i++) {
				if (columnWidths[i] < naturalWidths[i]) {
					columnWidths[i]++;
					remaining--;
					grew = true;
				}
			}
			if (!grew) {
				break;
			}
		}
	}

	// Render top border
	const topBorderCells = columnWidths.map((w) => "─".repeat(w));
	lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

	// Render header with wrapping
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

	// Render separator
	const separatorCells = columnWidths.map((w) => "─".repeat(w));
	const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
	lines.push(separatorLine);

	// Render rows with wrapping
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

	// Render bottom border
	const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
	lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

	if (nextTokenType && nextTokenType !== "space") {
		lines.push(""); // Add spacing after table
	}
	return lines;
}
