import type { AutocompleteProvider } from "../autocomplete.ts";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	renderFakeCursor,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import { insertTextAtCursorInternal } from "./editor/editing.ts";
import { addToHistory } from "./editor/history.ts";
import { handleEditorInput } from "./editor/input.ts";
import { createScrollBorder } from "./editor/layout.ts";
import { EditorModel } from "./editor/model.ts";
import { handleEditorMouse } from "./editor/movement.ts";
import type { EditorOptions, EditorTheme } from "./editor/types.ts";

export type { TextChunk } from "./editor/word-wrap.ts";
export { wordWrapLine } from "./editor/word-wrap.ts";
export type { EditorOptions, EditorTheme } from "./editor/types.ts";

export class Editor implements Component, Focusable {
	/**
	 * Text, cursor, history, kill ring, undo and autocomplete state, shared with the
	 * input, editing, movement and autocomplete modules in `./editor/`.
	 */
	private readonly model: EditorModel;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	protected tui: TUI;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.model = new EditorModel(
			{
				getTui: () => this.tui,
				isSubmitDisabled: () => this.disableSubmit,
				getText: () => this.getText(),
				handleInput: (data) => this.handleInput(data),
				notifyChange: () => {
					if (this.onChange) this.onChange(this.getText());
				},
				notifySubmit: (text) => {
					if (this.onChange) this.onChange("");
					if (this.onSubmit) this.onSubmit(text);
				},
			},
			theme,
		);
		this.tui = tui;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.model.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.model.autocomplete.autocompleteMaxVisible = Number.isFinite(maxVisible)
			? Math.max(3, Math.min(20, Math.floor(maxVisible)))
			: 5;
	}

	/**
	 * Text rows drawn by the last render. Octocode's prompt box reads this by name
	 * (`decorateEditor` in coding-agent) to place its side borders.
	 */
	private get renderedVisibleLineCount(): number {
		return this.model.renderedVisibleLineCount;
	}

	getPaddingX(): number {
		return this.model.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.model.paddingX !== newPadding) {
			this.model.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.model.autocomplete.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.model.autocomplete.autocompleteMaxVisible !== newMaxVisible) {
			this.model.autocomplete.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.model.autocomplete.setAutocompleteProvider(provider);
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		addToHistory(this.model, text);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		const border = hiddenLineCount > 0 ? createScrollBorder("↑", hiddenLineCount, width) : "─".repeat(width);
		return this.borderColor(border);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		const border = hiddenLineCount > 0 ? createScrollBorder("↓", hiddenLineCount, width) : "─".repeat(width);
		return this.borderColor(border);
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.model.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		this.model.lastWidth = layoutWidth;

		// Layout the text
		const layoutLines = this.model.layoutText(layoutWidth);

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Find the cursor line index in layoutLines
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		// Adjust scroll offset to keep cursor visible
		if (cursorLineIndex < this.model.scrollOffset) {
			this.model.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.model.scrollOffset + maxVisibleLines) {
			this.model.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.model.scrollOffset = Math.max(0, Math.min(this.model.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		const visibleLines = layoutLines.slice(this.model.scrollOffset, this.model.scrollOffset + maxVisibleLines);
		this.model.renderedVisibleLineCount = visibleLines.length;

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		result.push(this.renderTopBorder(width, this.model.scrollOffset));

		// Render each visible layout line
		// Emit hardware cursor marker when focused so TUI can position the
		// hardware cursor for IME candidate-window placement even while
		// autocomplete (e.g. slash-command menu) is visible.
		const emitCursorMarker = this.focused;

		for (const layoutLine of visibleLines) {
			let displayText = layoutLine.text;
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			// Add cursor if this line has it
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = [...this.model.segment(after, "grapheme")];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = renderFakeCursor(firstGrapheme);
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
				} else {
					// Cursor is at the end - add highlighted space
					const cursor = renderFakeCursor(" ");
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// Calculate padding based on actual visible width
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Render bottom border (with scroll indicator if more content below)
		const linesBelow = layoutLines.length - (this.model.scrollOffset + visibleLines.length);
		result.push(this.renderBottomBorder(width, linesBelow));

		// Add autocomplete list if active
		this.model.renderedAutocompleteHeight = 0;
		if (this.model.autocomplete.autocompleteState && this.model.autocomplete.autocompleteList) {
			const autocompleteResult = this.model.autocomplete.autocompleteList.render(contentWidth);
			this.model.renderedAutocompleteHeight = autocompleteResult.length;
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return handleEditorMouse(this.model, event);
	}

	handleInput(data: string): void {
		handleEditorInput(this.model, data);
	}

	getText(): string {
		return this.model.state.lines.join("\n");
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.model.expandPasteMarkers(this.model.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.model.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.model.state.cursorLine, col: this.model.state.cursorCol };
	}

	setText(text: string): void {
		this.model.autocomplete.cancelAutocomplete();
		this.model.lastAction = null;
		this.model.exitHistoryBrowsing();
		const normalized = this.model.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.getText() !== normalized) {
			this.model.pushUndoSnapshot();
		}
		this.model.pastes.clear();
		this.model.pasteCounter = 0;
		this.model.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.model.autocomplete.cancelAutocomplete();
		this.model.pushUndoSnapshot();
		this.model.lastAction = null;
		this.model.exitHistoryBrowsing();
		insertTextAtCursorInternal(this.model, text);
	}

	public isShowingAutocomplete(): boolean {
		return this.model.autocomplete.isShowingAutocomplete();
	}
}
