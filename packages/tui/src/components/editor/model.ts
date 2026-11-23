import { KillRing } from "../../kill-ring.ts";
import type { TUI } from "../../tui.ts";
import { UndoStack } from "../../undo-stack.ts";
import { BracketedPasteBuffer } from "../input/paste.ts";
import { EditorAutocomplete, type EditorAutocompleteHost } from "./autocomplete.ts";
import { endsInSlash, endsInSlashToken } from "./autocomplete-patterns.ts";
import { buildVisualLineMap, findVisualLineAt, layoutText } from "./layout.ts";
import { expandPasteMarkers, graphemeSegmenter, segmentWithMarkers, wordSegmenter } from "./segmentation.ts";
import type { EditorLastAction, EditorSnapshot, EditorState, EditorTheme, HistoryEntry, LayoutLine } from "./types.ts";
import { EditorWrapCache } from "./wrap-cache.ts";

/** Undo snapshots share the text and paste strings: only their containers are copied. */
export const createUndoStack = (): UndoStack<EditorSnapshot> =>
	new UndoStack<EditorSnapshot>((snapshot) => ({
		state: { ...snapshot.state, lines: [...snapshot.state.lines] },
		pastes: new Map(snapshot.pastes),
		pasteCounter: snapshot.pasteCounter,
	}));

/** A submitted draft: the editor state, paste registry and undo history the submit cleared, and the text it sent. */
export interface SubmittedDraft extends EditorSnapshot {
	text: string;
	undo: UndoStack<EditorSnapshot>;
}

/** Public `Editor` members the internal editor model reads live, including members subclasses override. */
interface EditorHost {
	getTui(): TUI;
	isSubmitDisabled(): boolean;
	/** `Editor.getText()`. */
	getText(): string;
	/** `Editor.handleInput()`, used to replay input that follows a bracketed paste. */
	handleInput(data: string): void;
	/** Call `onChange` with the current text, when set. */
	notifyChange(): void;
	/** Call `onChange("")`, then `onSubmit(text)`, each when set. */
	notifySubmit(text: string): void;
}

/** Internal state of an `Editor`, shared by its input, editing, movement and autocomplete modules. */
export class EditorModel implements EditorAutocompleteHost {
	state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	paddingX: number = 0;

	// Store last render geometry for cursor navigation and mouse hit-testing.
	lastWidth: number = 80;
	renderedVisibleLineCount = 1;
	renderedAutocompleteHeight = 0;

	scrollOffset: number = 0;

	pastes: Map<number, string> = new Map();
	pasteCounter: number = 0;

	/** Collects a bracketed paste across input chunks. */
	readonly bracketedPaste = new BracketedPasteBuffer();

	history: HistoryEntry[] = [];
	historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	historyDraft: EditorSnapshot | null = null;
	/** Where a history recall left the cursor: while it stays there, Up and Down keep browsing entries. */
	historyRecallCursor: { line: number; col: number } | null = null;

	/**
	 * The draft the last submit cleared (markers, cursor, undo) with the text it sent, kept until the editor is edited
	 * again: a submit the app refuses puts it back whole, and the prompt history keeps its markers collapsed.
	 */
	submitted: SubmittedDraft | undefined;

	killRing = new KillRing();
	lastAction: EditorLastAction = null;

	jumpMode: "forward" | "backward" | null = null;

	/** The whole suggested input the app set; its untyped rest shows as ghost text (`ghost.ts`). */
	inlineSuggestion: string | undefined;

	// Preferred visual column for vertical cursor movement (sticky column)
	preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	snappedFromCursorCol: number | null = null;

	undoStack = createUndoStack();

	readonly autocomplete: EditorAutocomplete;

	readonly host: EditorHost;
	private readonly wrapCache = new EditorWrapCache();

	constructor(host: EditorHost, theme: EditorTheme) {
		this.host = host;
		this.autocomplete = new EditorAutocomplete(this, theme);
	}

	getText(): string {
		return this.host.getText();
	}

	notifyChange(): void {
		this.host.notifyChange();
	}

	requestRender(): void {
		this.host.getTui().requestRender();
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	segment(text: string, mode: "word" | "grapheme"): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, mode === "word" ? wordSegmenter : graphemeSegmenter, this.validPasteIds());
	}

	isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	exitHistoryBrowsing(): void {
		this.historyIndex = -1;
		this.historyDraft = null;
		this.historyRecallCursor = null;
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	setTextInternal(text: string, cursorPlacement: "start" | "end" = "end"): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = cursorPlacement === "start" ? 0 : this.state.lines.length - 1;
		this.setCursorCol(cursorPlacement === "start" ? 0 : this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		this.scrollOffset = 0;

		this.notifyChange();
	}

	layoutText(contentWidth: number): LayoutLine[] {
		return layoutText(this.state, this.wrappedLines(contentWidth));
	}

	private wrappedLines(width: number) {
		return this.wrapCache.forLines(this.state.lines, width, this.pastes.keys(), (line) => [
			...this.segment(line, "grapheme"),
		]);
	}

	expandPasteMarkers(text: string): string {
		return expandPasteMarkers(text, this.pastes);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		return buildVisualLineMap(this.state.lines, this.wrappedLines(width));
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	findCurrentVisualLine(visualLines: Array<{ logicalLine: number; startCol: number; length: number }>): number {
		return findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	pushUndoSnapshot(): void {
		this.undoStack.push({ state: this.state, pastes: this.pastes, pasteCounter: this.pasteCounter });
	}

	undo(): void {
		this.exitHistoryBrowsing();
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot.state);
		this.pastes = snapshot.pastes;
		this.pasteCounter = snapshot.pasteCounter;
		this.lastAction = null;
		this.preferredVisualCol = null;
		this.notifyChange();
	}

	// The command menu belongs to the first line of the input.
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	/** True right after a `/` typed at the start of the input (the command menu). */
	isAtStartOfMessage(beforeCursor = this.textBeforeCursor()): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const trimmed = beforeCursor.trim();
		return trimmed === "" || trimmed === "/";
	}

	/** True right after a `/` typed at a token start anywhere else (a line start or after whitespace): the skill menu. */
	isAtSkillMentionStart(beforeCursor = this.textBeforeCursor()): boolean {
		return endsInSlash(beforeCursor);
	}

	textBeforeCursor(): string {
		return (this.state.lines[this.state.cursorLine] || "").slice(0, this.state.cursorCol);
	}

	isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	/** True while the text before the cursor ends in a `/name` token that follows whitespace or a line start. */
	isInSkillMentionContext(textBeforeCursor: string): boolean {
		return endsInSlashToken(textBeforeCursor);
	}
}
