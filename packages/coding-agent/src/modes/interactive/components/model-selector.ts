import { type Model, modelsAreEqual } from "@octocodeai/octocode-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@octocodeai/octocode-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { keyHint } from "../../../theme/theme-tui-helpers.ts";
import {
	type DefaultModelReference,
	type DefaultModelContext,
	isDefaultModel,
	isDefaultSearch,
	type ModelItem,
	type ModelScope,
	type ScopedModelItem,
	sortModelItems,
	groupModelItems,
} from "./model-selector/model-items.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { filterByProvider, providerLine, providersOf, stepProvider } from "./model-selector/provider-filter.ts";
import { updateModelList } from "./model-selector/list-view.ts";
import { ModelPickerHints } from "./model-selector/picker-hints.ts";
import { type SwitchChoice, SwitchChoiceSlot } from "./model-selector/switch-choice.ts";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	/** The one provider shown, switched with left/right; undefined shows every provider. */
	private providerFilter?: string;
	private providerText: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;
	private details = false;
	private detailOffset = 0;
	private layoutWidth = 80;
	private choiceSlot = new SwitchChoiceSlot();

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
		defaultContext?: DefaultModelContext,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 && !initialSearchInput?.endsWith("/") ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());

		this.addChild(new Text(theme.fg("accent", theme.bold("Choose a model for this chat")), 0, 0));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					defaultModel
						? `Startup default (${defaultContext?.source ?? "global"}): ${defaultModel.provider}/${defaultModel.id}`
						: "Startup default: automatic",
				),
				0,
				0,
			),
		);
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
		}
		this.providerText = new Text(providerLine(undefined), 0, 0);
		this.addChild(this.providerText);
		if (scopedModels.length === 0) this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(this.choiceSlot);
		this.addChild(new ModelPickerHints(Boolean(this.onSelectAsDefaultCallback)));

		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = sortModelItems(models, this.currentModel, this.defaultModel);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels
			.filter((scoped) => models.some((available) => modelsAreEqual(available.model, scoped.model)))
			.map((scoped) => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
			}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			const selected = this.filteredModels[this.selectedIndex]?.model;
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue(), selected);
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${errorMessage(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText} · ${keyHint("tui.input.tab", "scope")}`;
	}

	private isDefaultModel(model: Model<any>): boolean {
		return isDefaultModel(this.defaultModel, model);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string, selected?: Model<any>): void {
		const shown = filterByProvider(this.activeModels, this.providerFilter);
		this.providerFilter = shown.filter;
		this.providerText.setText(providerLine(shown.filter));
		const pool = shown.items;
		if (query) {
			const candidates = query.endsWith("/") ? pool.filter((item) => item.provider === query.slice(0, -1)) : pool;
			const filtered = fuzzyFilter(candidates, query, (item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			});
			if (isDefaultSearch(query)) {
				const defaultItems = pool.filter((item) => this.isDefaultModel(item.model));
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				this.filteredModels = [
					...defaultItems,
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				this.filteredModels = this.scope === "all" ? groupModelItems(filtered) : filtered;
			}
		} else {
			this.filteredModels = pool;
		}
		// Catalog refresh keeps the browsed model when it remains available. A changed
		// query selects its best match; clearing it keeps the current position clamped.
		const retained = selected ? this.filteredModels.findIndex((item) => modelsAreEqual(selected, item.model)) : -1;
		this.selectedIndex =
			retained >= 0 ? retained : query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.detailOffset = updateModelList(this.listContainer, {
			items: this.filteredModels,
			selectedIndex: this.selectedIndex,
			currentModel: this.currentModel,
			defaultModel: this.defaultModel,
			runtime: this.modelRuntime,
			width: this.layoutWidth,
			details: this.details,
			detailOffset: this.detailOffset,
			searched: this.searchInput.getValue().trim() !== "",
			scoped: this.scope === "scoped",
			error: this.errorMessage,
			refresh: this.refreshStatusMessage,
			refreshed: this.refreshStatusSuccess,
		});
	}

	override render(width: number): string[] {
		if (this.layoutWidth !== width) {
			this.layoutWidth = width;
			this.updateList();
		}
		return super.render(width);
	}

	handleInput(keyData: string): void {
		if (this.closed) return;
		if (this.choiceSlot.active) {
			this.choiceSlot.handleInput(keyData);
			return this.tui.requestRender();
		}
		const kb = getKeybindings();
		if (this.details && (kb.matches(keyData, "tui.select.pageUp") || kb.matches(keyData, "tui.select.pageDown"))) {
			this.detailOffset += kb.matches(keyData, "tui.select.pageUp") ? -5 : 5;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp") || kb.matches(keyData, "tui.select.pageDown")) {
			const step = kb.matches(keyData, "tui.select.pageUp") ? -3 : 3;
			this.selectedIndex = Math.max(0, Math.min(this.filteredModels.length - 1, this.selectedIndex + step));
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "app.models.details")) {
			this.details = !this.details;
			this.detailOffset = 0;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModels.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
			}
			return;
		}
		if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.editor.cursorRight")) {
			const step = kb.matches(keyData, "tui.editor.cursorLeft") ? -1 : 1;
			this.providerFilter = stepProvider(providersOf(this.activeModels), this.providerFilter, step);
			this.selectedIndex = 0;
			this.filterModels(this.searchInput.getValue());
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		} else if (
			this.onSelectAsDefaultCallback &&
			(kb.matches(keyData, "app.models.save") || (keyData === "d" && this.searchInput.getValue() === ""))
		) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.dispose();
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		} else {
			const query = this.searchInput.getValue();
			this.searchInput.handleInput(keyData);
			if (this.searchInput.getValue() !== query) this.filterModels(this.searchInput.getValue());
		}
	}

	/** Enter: ask what to do when a default can be saved, otherwise switch this chat. */
	private handleSelect(model: Model<any>): void {
		const asDefault = this.onSelectAsDefaultCallback;
		if (!asDefault) return this.finish(model, "chat");
		this.choiceSlot.open(model, (choice) => this.finish(model, choice));
		this.tui.requestRender();
	}

	private finish(model: Model<any>, choice: SwitchChoice): void {
		this.dispose();
		if (choice !== "default") this.onSelectCallback(model);
		if (choice !== "chat") this.onSelectAsDefaultCallback?.(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
