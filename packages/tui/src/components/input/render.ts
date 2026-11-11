import { CURSOR_MARKER, renderFakeCursor } from "../../tui/cursor.ts";
import { truncateToWidth } from "../../utils/truncate.ts";
import { sliceByColumn } from "../../utils/columns.ts";
import { getGraphemeSegmenter, visibleWidth } from "../../utils/width.ts";

const segmenter = getGraphemeSegmenter();

/** What the single-line input needs to draw itself. */
interface InputRenderState {
	prompt: string;
	placeholder: string;
	placeholderStyle: (text: string) => string;
	value: string;
	cursor: number;
	focused: boolean;
}

interface InputRenderResult {
	lines: string[];
	/** First visible value column; absent when the prompt or placeholder was drawn instead. */
	renderedStartColumn?: number;
}

/** Render the prompt and the horizontally scrolled value with the fake cursor. */
export function renderInputLine(state: InputRenderState, width: number): InputRenderResult {
	const availableWidth = width - visibleWidth(state.prompt);

	if (availableWidth <= 0) {
		return { lines: [truncateToWidth(state.prompt, width, "")] };
	}

	if (state.value.length === 0 && state.placeholder) {
		const placeholder = truncateToWidth(state.placeholder, availableWidth, "");
		const graphemes = [...segmenter.segment(placeholder)];
		const atCursor = graphemes[0]?.segment ?? " ";
		const afterCursor = placeholder.slice(atCursor.length);
		const marker = state.focused ? CURSOR_MARKER : "";
		const cursorChar = renderFakeCursor(state.placeholderStyle(atCursor));
		const textWithCursor = marker + cursorChar + state.placeholderStyle(afterCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(textWithCursor)));
		return { lines: [state.prompt + textWithCursor + padding] };
	}

	let visibleText = "";
	let cursorDisplay = state.cursor;
	let renderedStartColumn = 0;
	const totalWidth = visibleWidth(state.value);

	if (totalWidth < availableWidth) {
		// Everything fits (leave room for cursor at end)
		visibleText = state.value;
	} else {
		// Need horizontal scrolling
		// Reserve one column for cursor if it's at the end
		const scrollWidth = state.cursor === state.value.length ? availableWidth - 1 : availableWidth;
		const cursorCol = visibleWidth(state.value.slice(0, state.cursor));

		if (scrollWidth > 0) {
			const halfWidth = Math.floor(scrollWidth / 2);
			let startCol = 0;

			if (cursorCol < halfWidth) {
				startCol = 0;
			} else if (cursorCol > totalWidth - halfWidth) {
				startCol = Math.max(0, totalWidth - scrollWidth);
			} else {
				startCol = Math.max(0, cursorCol - halfWidth);
			}

			renderedStartColumn = startCol;
			visibleText = sliceByColumn(state.value, startCol, scrollWidth, true);
			const beforeCursor = sliceByColumn(state.value, startCol, Math.max(0, cursorCol - startCol), true);
			cursorDisplay = beforeCursor.length;
		} else {
			visibleText = "";
			cursorDisplay = 0;
		}
	}

	// Build line with fake cursor
	// Insert cursor character at cursor position
	const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
	const cursorGrapheme = graphemes[0];

	const beforeCursor = visibleText.slice(0, cursorDisplay);
	const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
	const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

	// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
	const marker = state.focused ? CURSOR_MARKER : "";

	// TUI draws the fake cursor in reverse video, or omits it when the hardware cursor is shown
	const cursorChar = renderFakeCursor(atCursor);
	const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

	const visualLength = visibleWidth(textWithCursor);
	const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
	const line = state.prompt + textWithCursor + padding;

	return { lines: [line], renderedStartColumn };
}

/** Map a value column to the index of the grapheme drawn there, or the end of the value past its last grapheme. */
export function cursorAtColumn(value: string, targetColumn: number): number {
	let currentColumn = 0;
	for (const grapheme of segmenter.segment(value)) {
		const nextColumn = currentColumn + visibleWidth(grapheme.segment);
		if (targetColumn < nextColumn) {
			return grapheme.index;
		}
		currentColumn = nextColumn;
	}
	return value.length;
}
