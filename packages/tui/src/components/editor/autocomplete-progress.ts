import type { AutocompleteProvider } from "../../autocomplete/types.ts";
import type { SelectList } from "../select-list.ts";
import type { TokenPattern } from "./autocomplete-patterns.ts";
import { findAtQuery, startProgressTicker } from "./autocomplete-token.ts";
import type { EditorState } from "./types.ts";

/** What the progress row reads from the editor autocomplete and how it opens the placeholder list. */
export interface IndexingProgressOwner {
	readonly autocompleteProvider?: AutocompleteProvider;
	readonly autocompleteList?: SelectList;
	readonly autocompleteIndexing: boolean;
	readonly autocompleteTriggerPattern: TokenPattern;
	/** Replaces the list with a row-less `@` list that shows `emptyText`. */
	showPlaceholder(query: string, indexing: boolean, emptyText?: string): void;
}

/** The "Indexing… N files" row of an `@` list while the provider builds its file index. */
export class AutocompleteIndexingProgress {
	private stopTicker?: () => void;
	private readonly owner: IndexingProgressOwner;
	private readonly host: { readonly state: EditorState; requestRender(): void };

	constructor(owner: IndexingProgressOwner, host: { readonly state: EditorState; requestRender(): void }) {
		this.owner = owner;
		this.host = host;
	}

	/** Shows the row when the provider reports progress, no list is open and the cursor is in an `@` token; refreshes it until `stop()` or the list stops indexing. */
	show(): void {
		const status = this.owner.autocompleteProvider?.indexingStatus?.();
		const query = findAtQuery(this.host.state, this.owner.autocompleteTriggerPattern);
		if (!status || this.owner.autocompleteList || query === null) return;
		this.owner.showPlaceholder(query, true, status);
		this.host.requestRender();
		this.stopTicker = startProgressTicker(
			() => (this.owner.autocompleteIndexing ? this.owner.autocompleteProvider?.indexingStatus?.() : null),
			(text) => {
				this.owner.autocompleteList?.setEmptyText(text);
				this.host.requestRender();
			},
		);
	}

	stop(): void {
		this.stopTicker?.();
		this.stopTicker = undefined;
	}
}
