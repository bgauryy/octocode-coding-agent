import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../../autocomplete/types.ts";
import { SelectList } from "../select-list.ts";
import {
	ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS,
	buildDebouncePattern,
	buildTriggerPattern,
	DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS,
	getBestAutocompleteMatchIndex,
	SLASH_COMMAND_SELECT_LIST_LAYOUT,
} from "./autocomplete-patterns.ts";
import { AutocompleteIndexingProgress } from "./autocomplete-progress.ts";
import { untilAutocompleteAborted } from "./autocomplete-request.ts";
import {
	findAtQuery,
	findTokenStart,
	isDirectoryItem,
	isInsideToken,
	listOptions,
	mergeTriggerCharacters,
	type DismissedToken,
} from "./autocomplete-token.ts";
import type { EditorLastAction, EditorState, EditorTheme } from "./types.ts";

/** Editor state and operations the autocomplete controller reads and calls live. */
export interface EditorAutocompleteHost {
	readonly state: EditorState;
	lastAction: EditorLastAction;
	/** The editor's current text, dispatched through `Editor.getText()`. */
	getText(): string;
	/** Call the editor's `onChange` with the current text, when set. */
	notifyChange(): void;
	requestRender(): void;
	pushUndoSnapshot(): void;
	setCursorCol(col: number): void;
	isInSlashCommandContext(textBeforeCursor: string): boolean;
}

/** Autocomplete support: provider requests, debouncing, cancellation and the suggestion list. */
export class EditorAutocomplete {
	autocompleteProvider?: AutocompleteProvider;
	autocompleteTriggerCharacters = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	autocompleteTriggerPattern = buildTriggerPattern(this.autocompleteTriggerCharacters);
	private autocompleteDebouncePattern = buildDebouncePattern(this.autocompleteTriggerCharacters);
	autocompleteList?: SelectList;
	autocompleteState: "regular" | "force" | null = null;
	autocompletePrefix: string = "";
	autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;
	private autocompletePending = false;
	private dismissed?: DismissedToken;
	/** True while the list is a placeholder for a file index that is still building. */
	autocompleteIndexing = false;
	/** The width the editor last drew the list at; undefined before it drew one. */
	listWidth: number | undefined;

	private readonly host: EditorAutocompleteHost;
	private readonly theme: EditorTheme;
	private readonly indexingProgress: AutocompleteIndexingProgress;

	constructor(host: EditorAutocompleteHost, theme: EditorTheme) {
		this.host = host;
		this.theme = theme;
		this.indexingProgress = new AutocompleteIndexingProgress(this, host);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
		this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
	}

	private createAutocompleteList(prefix: string, items: AutocompleteItem[], emptyText?: string): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		const list = new SelectList(
			items,
			this.autocompleteMaxVisible,
			this.theme.selectList,
			layout,
			listOptions(prefix, emptyText),
		);
		list.onSelect = (selected) => this.acceptCompletion(selected);
		return list;
	}

	/** Replaces the completed prefix with `item` as one undo step; false when there is no provider. */
	insertCompletion(item: AutocompleteItem, prefix: string): boolean {
		if (!this.autocompleteProvider) return false;
		this.host.pushUndoSnapshot();
		this.host.lastAction = null;
		this.dismissed = undefined;
		const result = this.autocompleteProvider.applyCompletion(
			this.host.state.lines,
			this.host.state.cursorLine,
			this.host.state.cursorCol,
			item,
			prefix,
		);
		this.host.state.lines = result.lines;
		this.host.state.cursorLine = result.cursorLine;
		this.host.setCursorCol(result.cursorCol);
		return true;
	}

	/** Inserts the chosen item, closes the list and continues with the next slash-command argument. */
	acceptCompletion(item: AutocompleteItem): void {
		const drillIn = this.autocompletePrefix.startsWith("@") && isDirectoryItem(item);
		if (!this.insertCompletion(item, this.autocompletePrefix)) return;
		this.cancelAutocomplete();
		this.host.notifyChange();
		// A directory in an @ list opens its children at once.
		if (drillIn) this.tryTriggerAutocomplete(true);
		else this.continueCommandCompletion();
	}

	continueCommandCompletion(): void {
		const beforeCursor = (this.host.state.lines[this.host.state.cursorLine] || "").slice(0, this.host.state.cursorCol);
		if (this.host.isInSlashCommandContext(beforeCursor) && /\s$/.test(beforeCursor)) this.tryTriggerAutocomplete();
	}

	tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;
		this.dismissed = undefined;

		const currentLine = this.host.state.lines[this.host.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.host.state.cursorCol);

		if (this.host.isInSlashCommandContext(beforeCursor)) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;
		if (!options.force && !options.explicitTab && this.isDismissed()) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.host.state.lines,
					this.host.state.cursorLine,
					this.host.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;
		this.autocompletePending = true;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.host.getText();
			const snapshotLine = this.host.state.cursorLine;
			const snapshotCol = this.host.state.cursorCol;

			try {
				await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
				this.settleRequest(startToken);
			} catch {
				this.settleRequest(startToken);
				// A failed provider call yields no suggestions. The task must still settle: every later request awaits it,
				// so a rejection here would end autocomplete for the editor's lifetime.
				if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) return;
				this.autocompleteAbort = undefined;
				this.cancelAutocomplete();
				this.host.requestRender();
			}
		})();
		await this.autocompleteRequestTask;
	}

	private setAutocompleteTriggerCharacters(triggerCharacters: string[]): void {
		const next = mergeTriggerCharacters(triggerCharacters);
		this.autocompleteTriggerCharacters = next;
		this.autocompleteTriggerPattern = buildTriggerPattern(next);
		this.autocompleteDebouncePattern = buildDebouncePattern(next);
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.host.state.lines[this.host.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.host.state.cursorCol);
		return this.autocompleteDebouncePattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		const request = this.autocompleteProvider.getSuggestions(
			this.host.state.lines,
			this.host.state.cursorLine,
			this.host.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);
		this.indexingProgress.show();
		const suggestions = await untilAutocompleteAborted(request, controller.signal);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.indexingProgress.stop();
		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.showEmptyOrClose();
			this.host.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			this.insertCompletion(suggestions.items[0], suggestions.prefix);
			this.host.notifyChange();
			this.host.requestRender();
			return;
		}

		const shown = this.autocompleteState ? this.autocompleteList : undefined;
		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		// A key already painted its own frame: these suggestions need another only when the list looks different.
		if (!shown || !this.autocompleteList || !sameRows(shown, this.autocompleteList, this.listWidth)) {
			this.host.requestRender();
		}
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.host.getText() === snapshotText &&
			this.host.state.cursorLine === snapshotLine &&
			this.host.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompleteIndexing = false;
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	/** Ends the pending flag when `startToken` is still the newest request. */
	private settleRequest(startToken: number): void {
		if (startToken === this.autocompleteStartToken) this.autocompletePending = false;
	}

	/** True from a trigger until its suggestions arrive: Esc then cancels the request, not the agent. */
	hasPendingRequest(): boolean {
		return this.autocompletePending;
	}

	/** True while the cursor is still inside the token the user closed with Esc; clears the mark once it left. */
	isDismissed(): boolean {
		if (this.dismissed && !isInsideToken(this.dismissed, this.host.state)) this.dismissed = undefined;
		return this.dismissed !== undefined;
	}

	/** Replaces the list with a row-less `@` list that shows `emptyText` (no match, or index progress). */
	showPlaceholder(query: string, indexing: boolean, emptyText?: string): void {
		this.autocompleteIndexing = indexing;
		this.autocompletePrefix = `@${query}`;
		this.autocompleteList = this.createAutocompleteList(this.autocompletePrefix, [], emptyText);
		this.autocompleteState = "regular";
	}

	/** No suggestions: an `@` token keeps a "no files" row open; anything else closes the list. */
	private showEmptyOrClose(): void {
		const query = findAtQuery(this.host.state, this.autocompleteTriggerPattern);
		if (query === null) this.cancelAutocomplete();
		else this.showPlaceholder(query, false);
	}

	/** Esc: closes the list, cancels a pending request and keeps the token closed until the cursor leaves it. */
	dismissAutocomplete(): void {
		const token = findTokenStart(this.host.state, this);
		this.cancelAutocomplete();
		this.dismissed = token ?? undefined;
	}

	/** Forgets a dismissed token: a new trigger character was typed. */
	clearDismissal(): void {
		this.dismissed = undefined;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompletePending = false;
		this.indexingProgress.stop();
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteIndexing = false;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}

/** Whether two lists draw the same rows at `width` (unknown width: assume they differ). */
function sameRows(a: SelectList, b: SelectList, width: number | undefined): boolean {
	if (width === undefined) return false;
	const rowsA = a.render(width);
	const rowsB = b.render(width);
	return rowsA.length === rowsB.length && rowsA.every((row, index) => row === rowsB[index]);
}
