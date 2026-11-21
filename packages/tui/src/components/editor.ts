import type { AutocompleteProvider } from "../autocomplete/types.ts";
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "../tui/component.ts";
import { CURSOR_MARKER, renderFakeCursor } from "../tui/cursor.ts";
import type { TUI } from "../tui/types.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { visibleWidth } from "../utils/width.ts";
import { type DraftText, insertTextAtCursorInternal, prependedDraft, submitValue } from "./editor/editing.ts";
import { dimGhost, ghostSuffix } from "./editor/ghost.ts";
import { addToHistory, clearHistory } from "./editor/history.ts";
import { type EditorWordHighlight, linePainter } from "./editor/highlight.ts";
import { handleEditorInput } from "./editor/input.ts";
import { createScrollBorder } from "./editor/layout.ts";
import { EditorModel } from "./editor/model.ts";
import { handleEditorMouse } from "./editor/movement.ts";
import { handleEditorTextRun, routeTextRun } from "./editor/text-run.ts";
import type { EditorBorderDecorator, EditorOptions, EditorTheme } from "./editor/types.ts";

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

	/** Draws the border rows in place of the editor's own (see `EditorBorderDecorator`); undefined keeps them. */
	public borderDecorator: EditorBorderDecorator | undefined;

	/** Styles the words it finds in each rendered line (the cursor cell keeps its own style); undefined draws plain text. */
	public wordHighlight: EditorWordHighlight | undefined;

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	private readonly ghostStyle: (str: string) => string;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.model = new EditorModel(
			{
				getTui: () => this.tui,
				isSubmitDisabled: () => this.disableSubmit,
				getText: () => this.getText(),
				handleInput: (data) => this.handleInput(data),
				notifyChange: () => {
					// The submitted draft is restorable only into the editor its submit left empty.
					if (this.model.submitted && !this.model.isEditorEmpty()) this.model.submitted = undefined;
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
		this.ghostStyle = theme.ghostText ?? dimGhost;
		const paddingX = options.paddingX ?? 0;
		this.model.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.model.autocomplete.autocompleteMaxVisible = Number.isFinite(maxVisible)
			? Math.max(3, Math.min(20, Math.floor(maxVisible)))
			: 5;
	}

	/**
	 * Text rows the last render drew between its borders: `render` output is the top border, these rows, the bottom
	 * border, then any autocomplete rows. A decoration that frames the text rows reads it.
	 */
	get visibleLineCount(): number {
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

	/** Add a submitted prompt to the Up/Down history (the last 5 are kept). */
	addToHistory(text: string): void {
		addToHistory(this.model, text);
	}

	/** Forget the prompt history, as when another session is shown. */
	clearHistory(): void {
		clearHistory(this.model);
	}

	/**
	 * Sets the whole suggested input (or clears it): while the typed text is a prefix of it and the cursor is at the end,
	 * the rest shows dimmed after the cursor, and Right or End accepts it (`tui.editor.cursorWordRight` its next word).
	 */
	setInlineSuggestion(text: string | undefined): void {
		if (this.model.inlineSuggestion === text) return;
		this.model.inlineSuggestion = text;
		this.tui.requestRender();
	}

	getInlineSuggestion(): string | undefined {
		return this.model.inlineSuggestion;
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

	private border(edge: "top" | "bottom", width: number, hiddenLineCount: number): string {
		const standard = () =>
			edge === "top" ? this.renderTopBorder(width, hiddenLineCount) : this.renderBottomBorder(width, hiddenLineCount);
		return this.borderDecorator ? this.borderDecorator(edge, width, hiddenLineCount, standard) : standard();
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

		const layoutLines = this.model.layoutText(layoutWidth);

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		if (cursorLineIndex < this.model.scrollOffset) {
			this.model.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.model.scrollOffset + maxVisibleLines) {
			this.model.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.model.scrollOffset = Math.max(0, Math.min(this.model.scrollOffset, maxScrollOffset));

		const visibleLines = layoutLines.slice(this.model.scrollOffset, this.model.scrollOffset + maxVisibleLines);
		this.model.renderedVisibleLineCount = visibleLines.length;

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		result.push(this.border("top", width, this.model.scrollOffset));

		// Render each visible layout line
		// Emit hardware cursor marker when focused so TUI can position the
		// hardware cursor for IME candidate-window placement even while
		// autocomplete (e.g. slash-command menu) is visible.
		const emitCursorMarker = this.focused;

		for (const layoutLine of visibleLines) {
			const paint = linePainter(layoutLine.text, this.wordHighlight);
			let displayText = paint(0);
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = paint(0, layoutLine.cursorPos);
				const after = layoutLine.text.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = [...this.model.segment(after, "grapheme")];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = paint(layoutLine.cursorPos + firstGrapheme.length);
					const cursor = renderFakeCursor(firstGrapheme);
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
				} else {
					// Cursor is at the end: a highlighted space, or the first character of the ghost text and its dimmed rest
					const ghost = ghostSuffix(this.model);
					const shown = ghost ? truncateToWidth(ghost, Math.max(0, contentWidth - lineVisibleWidth), "") : "";
					const first = shown ? ([...this.model.segment(shown, "grapheme")][0]?.segment ?? "") : "";
					const cursor = renderFakeCursor(first || " ");
					displayText = before + marker + cursor + (first ? this.ghostStyle(shown.slice(first.length)) : "");
					lineVisibleWidth = lineVisibleWidth + (first ? visibleWidth(shown) : 1);
					// If cursor overflows content width into the padding, flag it
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Render bottom border (with scroll indicator if more content below)
		const linesBelow = layoutLines.length - (this.model.scrollOffset + visibleLines.length);
		result.push(this.border("bottom", width, linesBelow));

		// Add autocomplete list if active
		this.model.renderedAutocompleteHeight = 0;
		if (this.model.autocomplete.autocompleteState && this.model.autocomplete.autocompleteList) {
			this.model.autocomplete.listWidth = contentWidth;
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

	/**
	 * Typed characters from one terminal read: the result of `handleInput` for each, with one `onChange`. A `handleInput`
	 * replaced on the editor gets every character, unless it marks itself (`routeTextRun`): then only the characters it takes.
	 * Returns how much of `text` it handled: it stops after a key that did more than insert text (see `Component`).
	 */
	handleTextRun(text: string): number {
		return routeTextRun(
			this.handleInput,
			this.typedRunInput(),
			text,
			(run) => this.insertTypedRun(run),
			(char) => this.handleInput(char),
		);
	}

	/** The `handleInput` that `insertTypedRun` stands in for; a subclass that overrides both returns its own. */
	protected typedRunInput(): (data: string) => void {
		return Editor.prototype.handleInput;
	}

	/**
	 * Typed characters that `typedRunInput` would pass straight to the editing model, inserted together. Returns how much
	 * of `text` it handled, stopping after a key that did more than insert text.
	 */
	protected insertTypedRun(text: string): number {
		return handleEditorTextRun(this.model, text);
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
		this.replaceDraft({ text: this.model.normalizeText(text), pastes: new Map(), pasteCounter: 0 });
	}

	/** Put `text` before the draft, a blank line between them, keeping the draft's paste markers (`prependedDraft`). */
	prependText(text: string): void {
		this.replaceDraft(prependedDraft(this.model, this.model.normalizeText(text)));
	}

	private replaceDraft(draft: DraftText): void {
		this.model.submitted = undefined;
		this.model.autocomplete.cancelAutocomplete();
		this.model.inlineSuggestion = undefined;
		this.model.lastAction = null;
		this.model.exitHistoryBrowsing();
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.getText() !== draft.text) {
			this.model.pushUndoSnapshot();
		}
		this.model.pastes = draft.pastes;
		this.model.pasteCounter = draft.pasteCounter;
		this.model.setTextInternal(draft.text);
	}

	/** Submit the text as the submit key does; nothing while submit is disabled. */
	submit(): void {
		if (this.disableSubmit) return;
		submitValue(this.model);
	}

	/**
	 * Put `text` back after the app refused its submit (a busy shell, an unknown command): when `text` is what the last
	 * submit sent and the editor is still empty, the submitted draft returns whole, with its paste markers, cursor and
	 * undo history; otherwise this is `setText(text)`.
	 */
	restoreSubmitted(text: string): void {
		const draft = this.model.submitted;
		if (!draft || draft.text !== text || !this.model.isEditorEmpty()) {
			this.setText(text);
			return;
		}
		this.model.submitted = undefined;
		this.model.autocomplete.cancelAutocomplete();
		this.model.inlineSuggestion = undefined;
		this.model.lastAction = null;
		this.model.exitHistoryBrowsing();
		this.model.state = draft.state;
		this.model.pastes = draft.pastes;
		this.model.pasteCounter = draft.pasteCounter;
		this.model.undoStack = draft.undo;
		this.model.setCursorCol(draft.state.cursorCol);
		this.model.scrollOffset = 0;
		this.model.notifyChange();
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

	/** True while a suggestion request is in flight (no list yet): Esc then cancels it instead of the agent. */
	public hasPendingAutocomplete(): boolean {
		return this.model.autocomplete.hasPendingRequest();
	}
}
