export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	/** Indexes into `label` of the characters the query matched, for highlighting. */
	matches?: number[];
	/** What the item completes to; lets a renderer pick an icon or colour. */
	kind?: "file" | "directory" | "command";
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	argumentKind?: "path";
	/** A skill: a `/` typed at a token start inside the text lists it (named bare or `skill:name`), never a command. */
	skill?: boolean;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // What we're matching against (e.g., "/" or "src/")
}

export interface AutocompleteProvider {
	/** Characters that should naturally trigger this provider at token boundaries. */
	triggerCharacters?: string[];

	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	// Apply the selected item
	// Returns the new text and cursor position
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};

	/** Progress text such as "Indexing… 12 345 files" while the provider builds its file index, else null. */
	indexingStatus?(): string | null;

	// Check if file completion should trigger for explicit Tab completion
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}
