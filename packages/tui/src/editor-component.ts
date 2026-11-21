import type { AutocompleteProvider } from "./autocomplete/types.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// Core text access (required)

	/** Get the current text content */
	getText(): string;

	setText(text: string): void;

	/**
	 * Put `text` before the current draft, a blank line between them, keeping the draft's own markers (paste markers
	 * stay collapsed and still expand). Without it, callers join `text` with `getExpandedText()` through `setText`.
	 */
	prependText?(text: string): void;

	/** Put back `text` the app refused to submit, with the editor's own markers and cursor when it can; else `setText`. */
	restoreSubmitted?(text: string): void;

	/** Submit the current text as the submit key does. */
	submit?(): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// Callbacks (required)

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// History support (optional)

	addToHistory?(text: string): void;

	/** Forget the prompt history, as when another session is shown. */
	clearHistory?(): void;

	// Advanced text manipulation (optional)

	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// Autocomplete support (optional)

	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	/** Show the untyped rest of `text`, a whole suggested input, as ghost text after the cursor; undefined clears it. */
	setInlineSuggestion?(text: string | undefined): void;

	// Appearance (optional)

	borderColor?: (str: string) => string;

	setPaddingX?(padding: number): void;

	setAutocompleteMaxVisible?(maxVisible: number): void;
}
