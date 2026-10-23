import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../../autocomplete.ts";
import { isWhitespaceChar } from "../../utils.ts";
import { SelectList } from "../select-list.ts";
import {
	ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS,
	buildDebouncePattern,
	buildTriggerPattern,
	DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS,
	getBestAutocompleteMatchIndex,
	SLASH_COMMAND_SELECT_LIST_LAYOUT,
} from "./autocomplete-patterns.ts";
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

	private readonly host: EditorAutocompleteHost;
	private readonly theme: EditorTheme;

	constructor(host: EditorAutocompleteHost, theme: EditorTheme) {
		this.host = host;
		this.theme = theme;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
		this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
	}

	// Autocomplete methods
	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		const list = new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
		list.onSelect = (selected) => this.acceptCompletion(selected);
		return list;
	}

	/** Replaces the completed prefix with `item` as one undo step; false when there is no provider. */
	insertCompletion(item: AutocompleteItem, prefix: string): boolean {
		if (!this.autocompleteProvider) return false;
		this.host.pushUndoSnapshot();
		this.host.lastAction = null;
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
		if (!this.insertCompletion(item, this.autocompletePrefix)) return;
		this.cancelAutocomplete();
		this.host.notifyChange();
		this.continueCommandCompletion();
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

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private setAutocompleteTriggerCharacters(triggerCharacters: string[]): void {
		const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
		for (const character of triggerCharacters) {
			if (character.length !== 1 || character === "/" || isWhitespaceChar(character) || next.includes(character)) {
				continue;
			}
			next.push(character);
		}
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

		const suggestions = await this.autocompleteProvider.getSuggestions(
			this.host.state.lines,
			this.host.state.cursorLine,
			this.host.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.host.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			this.insertCompletion(suggestions.items[0], suggestions.prefix);
			this.host.notifyChange();
			this.host.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.host.requestRender();
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
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
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
