import { type AssistantMessage, type Model, modelsAreEqual } from "@octocodeai/octocode-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	ListView,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@octocodeai/octocode-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { providerAccessLabel } from "../../../core/provider-label.ts";
import { switchCacheNotice } from "../../../core/switch-cache-cost.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar, keyHint, keyText } from "../../../theme/theme-tui-helpers.ts";
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
import { filterByProvider, providerLine, providersOf, stepProvider } from "./model-selector/provider-filter.ts";
import { ModelDetailPanel } from "./model-selector/detail-panel.ts";
import { emptyModelListText } from "./model-selector/empty-state.ts";
import { pickerHints } from "./model-selector/hints.ts";
import { type RefreshStatus, refreshFailure, refreshStatus } from "./model-selector/refresh-status.ts";
import { modelRowLines } from "./model-selector/rows.ts";
import { listRows, listTheme } from "./list-kit.ts";

/** Lines around the list: borders, title, default, scope and provider lines, the panel, hints. */
const CHROME_ROWS = 18;
/** Model rows while the full details show under the list. */
const DETAIL_LIST_ROWS = 3;

/**
 * What a save key asks of the highlighted model: `both` switches this chat and saves it as the default for new chats;
 * `provider` makes it its provider's preferred model and leaves the chat as it is.
 */
export type ModelSave = "both" | "provider";

/**
 * The /model picker: a `⌕` search line over the models grouped by provider and the highlighted model's facts under it.
 * Enter switches this chat; the save key also saves the default; the open details offer the provider's preferred
 * model. Printable keys always search (a bare `d` too).
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private readonly list: ListView<ModelItem>;
	get focused(): boolean {
		return this.list.focused;
	}
	set focused(value: boolean) {
		this.list.focused = value;
	}
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>, save: ModelSave) => void;
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
	private readonly panel: ModelDetailPanel;
	private readonly hints = new HintBar([]);
	private lastReply?: () => Pick<AssistantMessage, "usage"> | undefined;

	private switchNoticeFor(item: ModelItem | undefined): string | undefined {
		return item ? switchCacheNotice(this.lastReply?.(), this.currentModel, item.model) : undefined;
	}

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>, save: ModelSave) => void,
		defaultModel?: DefaultModelReference,
		defaultContext?: DefaultModelContext,
		lastReply?: () => Pick<AssistantMessage, "usage"> | undefined,
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

		this.list = new ListView<ModelItem>({
			items: [],
			maxRows: this.listRowBudget(),
			theme: listTheme(),
			mark: false,
			search: {
				text: (item) => this.searchText(item),
				filter: (items, query) => this.filter(items, query),
				placeholder: "type to search",
			},
			row: (item, state) => this.row(item, state),
		});
		this.list.onSelect = (item) => {
			this.dispose();
			this.onSelectCallback(item.model);
		};
		this.list.onCancel = () => {
			this.dispose();
			this.onCancelCallback();
		};
		this.lastReply = lastReply;
		this.panel = new ModelDetailPanel(() => ({
			selected: this.list.getSelectedItem(),
			runtime: this.modelRuntime,
			details: this.details,
			canPrefer: this.onSelectAsDefaultCallback !== undefined,
			switchNotice: this.switchNoticeFor(this.list.getSelectedItem()),
			error: this.errorMessage,
			refresh: this.refreshStatusMessage,
			refreshed: this.refreshStatusSuccess,
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Choose a model for this chat")), 1, 0));
		const startup = defaultModel
			? `Startup default (${defaultContext?.source ?? "global"}): ${defaultModel.provider}/${defaultModel.id}`
			: defaultContext?.providerOnly
				? `Startup provider (${defaultContext.source}): ${defaultContext.providerOnly} · automatic model`
				: "Startup default: automatic";
		this.addChild(new TruncatedText(theme.fg("muted", startup), 1, 0));
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 1, 0);
			this.addChild(this.scopeText);
		}
		this.providerText = new Text(providerLine(undefined), 1, 0);
		this.addChild(this.providerText);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(this.panel);
		this.addChild(this.hints);
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		this.showModels();
		if (initialSearchInput) this.list.setQuery(initialSearchInput);
		else this.selectModel(this.currentModel);
		this.syncChrome();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private listRowBudget(): number {
		if (this.details) return DETAIL_LIST_ROWS;
		return listRows((this.tui as Partial<TUI>).terminal?.rows, CHROME_ROWS, 10);
	}

	private searchText(item: ModelItem): string {
		const defaultText = this.isDefaultModel(item.model) ? " default" : "";
		return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
	}

	/** Fuzzy search; `provider/` keeps one provider, and a prefix of `default` lists the default model first. */
	private filter(items: readonly ModelItem[], query: string): ModelItem[] {
		const candidates = query.endsWith("/") ? items.filter((item) => item.provider === query.slice(0, -1)) : [...items];
		const filtered = fuzzyFilter(candidates, query, (item) => this.searchText(item));
		if (isDefaultSearch(query)) {
			const defaults = items.filter((item) => this.isDefaultModel(item.model));
			return [...defaults, ...filtered.filter((item) => !defaults.includes(item))];
		}
		return this.scope === "all" ? groupModelItems(filtered) : filtered;
	}

	/** A provider heading where the provider changes or the window starts, then the model row. */
	private row(item: ModelItem, state: { selected: boolean; width: number }): string[] {
		const items = this.list.getItems();
		const index = items.indexOf(item);
		const heading = index === this.list.visibleRange().start || items[index - 1]?.provider !== item.provider;
		return modelRowLines(
			item,
			{ ...state, heading },
			{
				current: modelsAreEqual(this.currentModel, item.model),
				isDefault: this.isDefaultModel(item.model),
				kind: providerAccessLabel(this.modelRuntime, item.provider),
				added: this.modelRuntime.getCatalogUpdate(item.model)?.source === "models.dev",
				deprecated: this.modelRuntime.isModelDeprecated(item.model),
			},
		);
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
			this.showRefreshStatus(refreshStatus(result, timedOut, this.modelRuntime));
			// Catalog refresh keeps the browsed model when it remains available.
			const selected = this.list.getSelectedItem()?.model;
			this.loadModelsFromSnapshot();
			this.showModels();
			this.selectModel(selected);
			this.syncChrome();
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.showRefreshStatus(refreshFailure(error, timedOut));
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	private showRefreshStatus(status: RefreshStatus): void {
		this.errorMessage = status.error;
		this.refreshStatusMessage = status.message;
		this.refreshStatusSuccess = status.refreshed;
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

	/** Hands the list the active scope's models from the shown provider; the cursor keeps its index, clamped. */
	private showModels(): void {
		const shown = filterByProvider(this.activeModels, this.providerFilter);
		this.providerFilter = shown.filter;
		this.providerText.setText(providerLine(shown.filter));
		this.list.setItems(shown.items);
	}

	private selectModel(model: Model<any> | undefined): void {
		if (!model) return;
		const index = this.list.getItems().findIndex((item) => modelsAreEqual(model, item.model));
		if (index >= 0) this.list.setSelectedIndex(index);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.list.setSelectedIndex(0);
		this.showModels();
		this.selectModel(this.currentModel);
		this.scopeText?.setText(this.getScopeText());
	}

	/** The empty line names its recovery key, and the hints keep only the keys that act on what is shown. */
	private syncChrome(): void {
		const query = this.list.getQuery();
		const empty = this.list.getItems().length === 0;
		if (!empty) this.list.setEmpty(undefined);
		else if (query.trim()) this.list.setEmpty({ message: emptyModelListText(this.modelRuntime, query) });
		else if (this.scope === "scoped")
			this.list.setEmpty({
				message: "No available scoped shortcuts",
				recover: [keyText("tui.input.tab"), "all models"],
			});
		else this.list.setEmpty({ message: emptyModelListText(this.modelRuntime) });
		this.hints.setHints(
			pickerHints({ empty, canSave: this.onSelectAsDefaultCallback !== undefined, details: this.details }),
		);
	}

	override render(width: number): string[] {
		this.list.setMaxRows(this.listRowBudget());
		return super.render(width);
	}

	handleInput(keyData: string): void {
		if (this.closed) return;
		const kb = getKeybindings();
		const pageUp = kb.matches(keyData, "tui.select.pageUp");
		if (this.details && (pageUp || kb.matches(keyData, "tui.select.pageDown"))) {
			this.panel.scroll(pageUp ? -5 : 5);
			return;
		}
		if (kb.matches(keyData, "app.models.details")) {
			this.details = !this.details;
			this.panel.reset();
		} else if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModels.length > 0) this.setScope(this.scope === "all" ? "scoped" : "all");
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.editor.cursorRight")) {
			const step = kb.matches(keyData, "tui.editor.cursorLeft") ? -1 : 1;
			this.providerFilter = stepProvider(providersOf(this.activeModels), this.providerFilter, step);
			this.list.setSelectedIndex(0);
			this.showModels();
		} else if (this.onSelectAsDefaultCallback && kb.matches(keyData, "app.models.save")) {
			return this.save("both");
		} else if (this.onSelectAsDefaultCallback && this.details && kb.matches(keyData, "app.models.preferred")) {
			return this.save("provider");
		} else {
			this.list.handleInput(keyData);
		}
		if (!this.closed) this.syncChrome();
	}

	/** A save key closes the picker with the highlighted model; with no model shown it does nothing. */
	private save(save: ModelSave): void {
		const selected = this.list.getSelectedItem();
		if (!selected || !this.onSelectAsDefaultCallback) return;
		this.dispose();
		this.onSelectAsDefaultCallback(selected.model, save);
	}

	/** The search text the list filters by. */
	getQuery(): string {
		return this.list.getQuery();
	}
}
