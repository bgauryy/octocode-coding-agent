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

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// Callbacks (required)

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// History support (optional)

	addToHistory?(text: string): void;

	// Advanced text manipulation (optional)

	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// Autocomplete support (optional)

	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// Appearance (optional)

	borderColor?: (str: string) => string;

	setPaddingX?(padding: number): void;

	setAutocompleteMaxVisible?(maxVisible: number): void;
}
