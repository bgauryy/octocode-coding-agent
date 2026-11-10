import type { TuiMouseEvent, TuiMouseEventResult } from "../../tui.ts";
import { visibleWidth } from "../../utils/width.ts";
import { findWordBackward, findWordForward } from "../../word-navigation.ts";
import { findVisualLineAt } from "./layout.ts";
import type { EditorModel } from "./model.ts";
import { isPasteMarker } from "./segmentation.ts";

/**
 * Move cursor to a target visual line, applying sticky column logic.
 * Shared by moveCursor() and pageScroll().
 */
function moveToVisualLine(
	editor: EditorModel,
	visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	currentVisualLine: number,
	targetVisualLine: number,
): void {
	const currentVL = visualLines[currentVisualLine];
	const targetVL = visualLines[targetVisualLine];
	if (!(currentVL && targetVL)) return;

	// When the cursor was snapped to a segment start, resolve the pre-snap
	// position against the VL it belongs to. This gives the correct visual
	// column even after a resize reshuffles VLs.
	let currentVisualCol: number;
	if (editor.snappedFromCursorCol !== null) {
		const vlIndex = findVisualLineAt(visualLines, currentVL.logicalLine, editor.snappedFromCursorCol);
		currentVisualCol = editor.snappedFromCursorCol - visualLines[vlIndex].startCol;
	} else {
		currentVisualCol = editor.state.cursorCol - currentVL.startCol;
	}

	// For non-last segments, clamp to length-1 to stay within the segment
	const isLastSourceSegment =
		currentVisualLine === visualLines.length - 1 ||
		visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
	const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

	const isLastTargetSegment =
		targetVisualLine === visualLines.length - 1 ||
		visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
	const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

	const moveToVisualCol = computeVerticalMoveColumn(editor, currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

	editor.state.cursorLine = targetVL.logicalLine;
	const targetCol = targetVL.startCol + moveToVisualCol;
	const logicalLine = editor.state.lines[targetVL.logicalLine] || "";
	editor.state.cursorCol = Math.min(targetCol, logicalLine.length);

	// Snap cursor to atomic segment boundary (e.g. paste markers)
	// so the cursor never lands in the middle of a multi-grapheme unit.
	// Single-grapheme segments don't need snapping.
	const segments = [...editor.segment(logicalLine, "grapheme")];
	for (const seg of segments) {
		if (seg.index > editor.state.cursorCol) break;
		if (seg.segment.length <= 1) continue;
		if (editor.state.cursorCol < seg.index + seg.segment.length) {
			const isContinuation = seg.index < targetVL.startCol;
			const isMovingDown = targetVisualLine > currentVisualLine;

			if (isContinuation && isMovingDown) {
				// The segment started on a previous visual line, and we
				// already visited it on the way down. Skip all remaining
				// continuation VLs and land on the first VL past it.
				const segEnd = seg.index + seg.segment.length;
				let next = targetVisualLine + 1;
				while (
					next < visualLines.length &&
					visualLines[next].logicalLine === targetVL.logicalLine &&
					visualLines[next].startCol < segEnd
				) {
					next++;
				}
				if (next < visualLines.length) {
					moveToVisualLine(editor, visualLines, currentVisualLine, next);
					return;
				}
			}

			// Snap to the start of the segment so it gets highlighted.
			// Store the pre-snap position so the next vertical move can
			// resolve it to the correct visual column.
			editor.snappedFromCursorCol = editor.state.cursorCol;
			editor.state.cursorCol = seg.index;
			return;
		}
	}

	// No snap occurred – we moved out of the atomic segment.
	editor.snappedFromCursorCol = null;
}

/**
 * Compute the target visual column for vertical cursor movement.
 * Implements the sticky column decision table:
 *
 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
 *
 * Where:
 * - P = preferred col is set
 * - S = cursor in middle of source line (not clamped to end)
 * - T = target line shorter than current visual col
 * - U = target line shorter than preferred col
 */
function computeVerticalMoveColumn(
	editor: EditorModel,
	currentVisualCol: number,
	sourceMaxVisualCol: number,
	targetMaxVisualCol: number,
): number {
	const hasPreferred = editor.preferredVisualCol !== null; // P
	const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
	const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

	if (!hasPreferred || cursorInMiddle) {
		if (targetTooShort) {
			// Cases 2 and 7
			editor.preferredVisualCol = currentVisualCol;
			return targetMaxVisualCol;
		}

		// Cases 1 and 6
		editor.preferredVisualCol = null;
		return currentVisualCol;
	}

	const targetCantFitPreferred = targetMaxVisualCol < editor.preferredVisualCol!; // U
	if (targetTooShort || targetCantFitPreferred) {
		// Cases 4 and 5
		return targetMaxVisualCol;
	}

	// Case 3
	const result = editor.preferredVisualCol!;
	editor.preferredVisualCol = null;
	return result;
}

export function moveToLineStart(editor: EditorModel): void {
	editor.lastAction = null;
	editor.setCursorCol(0);
}

export function moveToLineEnd(editor: EditorModel): void {
	editor.lastAction = null;
	const currentLine = editor.state.lines[editor.state.cursorLine] || "";
	editor.setCursorCol(currentLine.length);
}

export function moveCursor(editor: EditorModel, deltaLine: number, deltaCol: number): void {
	editor.lastAction = null;
	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const currentVisualLine = editor.findCurrentVisualLine(visualLines);

	if (deltaLine !== 0) {
		const targetVisualLine = currentVisualLine + deltaLine;

		if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
			moveToVisualLine(editor, visualLines, currentVisualLine, targetVisualLine);
		}
	}

	if (deltaCol !== 0) {
		const currentLine = editor.state.lines[editor.state.cursorLine] || "";

		if (deltaCol > 0) {
			// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
			if (editor.state.cursorCol < currentLine.length) {
				const afterCursor = currentLine.slice(editor.state.cursorCol);
				const graphemes = [...editor.segment(afterCursor, "grapheme")];
				const firstGrapheme = graphemes[0];
				editor.setCursorCol(editor.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
			} else if (editor.state.cursorLine < editor.state.lines.length - 1) {
				editor.state.cursorLine++;
				editor.setCursorCol(0);
			} else {
				// At end of last line - can't move, but set preferredVisualCol for up/down navigation
				const currentVL = visualLines[currentVisualLine];
				if (currentVL) {
					editor.preferredVisualCol = editor.state.cursorCol - currentVL.startCol;
				}
			}
		} else {
			// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
			if (editor.state.cursorCol > 0) {
				const beforeCursor = currentLine.slice(0, editor.state.cursorCol);
				const graphemes = [...editor.segment(beforeCursor, "grapheme")];
				const lastGrapheme = graphemes[graphemes.length - 1];
				editor.setCursorCol(editor.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
			} else if (editor.state.cursorLine > 0) {
				editor.state.cursorLine--;
				const prevLine = editor.state.lines[editor.state.cursorLine] || "";
				editor.setCursorCol(prevLine.length);
			}
		}
	}

	// Keep an open autocomplete picker in sync with the new cursor
	// position: cursor movement changes the text before the cursor, so a
	// picker computed for the old position is stale. Re-query so it
	// refreshes — or closes when the new position yields no suggestions —
	// mirroring insertCharacter()/handleBackspace(). Without this, arrowing
	// left from `/cmd ` back into the command name leaves the argument
	// picker showing against a `/cmd` prefix (and a Tab there would
	// concatenate the stale suggestion onto the partial command name).
	if (editor.autocomplete.autocompleteState) {
		editor.autocomplete.updateAutocomplete();
	}
}

/**
 * Scroll by a page (direction: -1 for up, 1 for down).
 * Moves cursor by the page size while keeping it in bounds.
 */
export function pageScroll(editor: EditorModel, direction: -1 | 1): void {
	editor.lastAction = null;
	const terminalRows = editor.host.getTui().terminal.rows;
	const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const currentVisualLine = editor.findCurrentVisualLine(visualLines);
	const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

	moveToVisualLine(editor, visualLines, currentVisualLine, targetVisualLine);
}

export function moveWordBackwards(editor: EditorModel): void {
	editor.lastAction = null;
	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	// If at start of line, move to end of previous line
	if (editor.state.cursorCol === 0) {
		if (editor.state.cursorLine > 0) {
			editor.state.cursorLine--;
			const prevLine = editor.state.lines[editor.state.cursorLine] || "";
			editor.setCursorCol(prevLine.length);
		}
		return;
	}

	editor.setCursorCol(
		findWordBackward(currentLine, editor.state.cursorCol, {
			segment: (text) => editor.segment(text, "word"),
			isAtomicSegment: isPasteMarker,
		}),
	);
}

/**
 * Jump to the first occurrence of a character in the specified direction.
 * Multi-line search. Case-sensitive. Skips the current cursor position.
 */
export function jumpToChar(editor: EditorModel, char: string, direction: "forward" | "backward"): void {
	editor.lastAction = null;
	const isForward = direction === "forward";
	const lines = editor.state.lines;

	const end = isForward ? lines.length : -1;
	const step = isForward ? 1 : -1;

	for (let lineIdx = editor.state.cursorLine; lineIdx !== end; lineIdx += step) {
		const line = lines[lineIdx] || "";
		const isCurrentLine = lineIdx === editor.state.cursorLine;

		// Current line: start after/before cursor; other lines: search full line
		const searchFrom = isCurrentLine
			? isForward
				? editor.state.cursorCol + 1
				: editor.state.cursorCol - 1
			: undefined;

		const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

		if (idx !== -1) {
			editor.state.cursorLine = lineIdx;
			editor.setCursorCol(idx);
			return;
		}
	}
	// No match found - cursor stays in place
}

export function moveWordForwards(editor: EditorModel): void {
	editor.lastAction = null;
	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	// If at end of line, move to start of next line
	if (editor.state.cursorCol >= currentLine.length) {
		if (editor.state.cursorLine < editor.state.lines.length - 1) {
			editor.state.cursorLine++;
			editor.setCursorCol(0);
		}
		return;
	}

	editor.setCursorCol(
		findWordForward(currentLine, editor.state.cursorCol, {
			segment: (text) => editor.segment(text, "word"),
			isAtomicSegment: isPasteMarker,
		}),
	);
}

export function handleEditorMouse(editor: EditorModel, event: TuiMouseEvent): TuiMouseEventResult | undefined {
	const autocompleteStartRow = editor.renderedVisibleLineCount + 2;
	if (
		editor.autocomplete.autocompleteState &&
		editor.autocomplete.autocompleteList &&
		event.y >= autocompleteStartRow &&
		event.y < autocompleteStartRow + editor.renderedAutocompleteHeight
	) {
		const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
		const paddingX = Math.min(editor.paddingX, maxPadding);
		const contentWidth = Math.max(1, event.width - paddingX * 2);
		const result = editor.autocomplete.autocompleteList.handleMouse?.({
			...event,
			x: event.x - paddingX,
			y: event.y - autocompleteStartRow,
			width: contentWidth,
			height: editor.renderedAutocompleteHeight,
		});
		return result ? { ...result, focus: true } : undefined;
	}

	// Leave press/drag/release unhandled so the renderer's screen-level text
	// selection can run over the editor rows (drag to select, release to copy).
	// The renderer synthesizes a click when press and release land on the same
	// cell without movement, which is the gesture that positions the cursor.
	if (event.type !== "click" || event.button !== "left") return undefined;
	if (event.y <= 0 || event.y > editor.renderedVisibleLineCount) return { handled: true, focus: true };

	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const visualLineIndex = editor.scrollOffset + event.y - 1;
	const visualLine = visualLines[visualLineIndex];
	if (!visualLine) return { handled: true, focus: true };
	const logicalLine = editor.state.lines[visualLine.logicalLine] ?? "";
	const chunkEnd = visualLine.startCol + visualLine.length;
	const chunk = logicalLine.slice(visualLine.startCol, chunkEnd);
	const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
	const paddingX = Math.min(editor.paddingX, maxPadding);
	const targetColumn = Math.max(0, event.x - paddingX);
	let visibleColumn = 0;
	let targetIndex = chunk.length;
	let lastGraphemeIndex = 0;
	for (const grapheme of editor.segment(chunk, "grapheme")) {
		const nextColumn = visibleColumn + visibleWidth(grapheme.segment);
		lastGraphemeIndex = grapheme.index;
		if (targetColumn < nextColumn) {
			targetIndex = grapheme.index;
			break;
		}
		visibleColumn = nextColumn;
	}
	const isLastSegment =
		visualLineIndex === visualLines.length - 1 ||
		visualLines[visualLineIndex + 1]?.logicalLine !== visualLine.logicalLine;
	if (!isLastSegment && targetIndex === chunk.length && chunk.length > 0) targetIndex = lastGraphemeIndex;

	editor.state.cursorLine = visualLine.logicalLine;
	editor.setCursorCol(visualLine.startCol + targetIndex);
	editor.lastAction = null;
	editor.exitHistoryBrowsing();
	if (editor.autocomplete.autocompleteState) editor.autocomplete.updateAutocomplete();
	return { handled: true, focus: true };
}
