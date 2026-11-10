import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	matchesKey,
	splitDoubleEscape,
	type TUI,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import type { AppKeybinding, KeybindingsManager } from "../core/keybindings.ts";

/** The working status the editor draws in its top border; the terminal's `StatusIndicator` implements it. */
interface BorderStatus {
	renderInBorder(width: number): string;
	renderSpinnerInBorder(width: number): string;
}

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: BorderStatus | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** A complete bracketed paste arrives here first; a returned string is inserted in its place. */
	public onPasteText?: (text: string) => string | undefined;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;
	/** Up in an empty editor without autocomplete; return true to take it, false to browse prompt history as usual. */
	public onEmptyUp?: () => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: BorderStatus | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	/** The paste with its text replaced by `onPasteText`, when the read holds one whole bracketed paste. */
	private rewriteBracketedPaste(data: string): string | undefined {
		const start = "\x1b[200~";
		const end = "\x1b[201~";
		if (!this.onPasteText || !data.startsWith(start) || !data.endsWith(end)) return undefined;
		const content = data.slice(start.length, -end.length);
		if (content.includes(start) || content.includes(end)) return undefined;
		const replacement = this.onPasteText(content);
		return replacement === undefined ? undefined : `${start}${replacement}${end}`;
	}

	handleInput(data: string): void {
		// Two Escapes that arrived in one read are two key presses, not Ctrl+Alt+[ (aborts and double-Esc need them).
		const presses = splitDoubleEscape(data);
		if (presses.length > 1) {
			for (const press of presses) this.handleInput(press);
			return;
		}
		const pasted = this.rewriteBracketedPaste(data);
		if (pasted !== undefined) {
			super.handleInput(pasted);
			return;
		}
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active (a list or a pending request takes Esc first)
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete() && !this.hasPendingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// An open list moves with Ctrl+P/Ctrl+N even though those cycle models by default.
		if (this.isShowingAutocomplete() && (matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+n"))) {
			super.handleInput(data);
			return;
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		if (
			this.onEmptyUp &&
			this.getText().length === 0 &&
			!this.isShowingAutocomplete() &&
			this.keybindings.matches(data, "tui.editor.cursorUp") &&
			this.onEmptyUp()
		) {
			return;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		super.handleInput(data);
	}
}
