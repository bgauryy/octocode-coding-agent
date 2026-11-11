import type { Model } from "@octocodeai/octocode-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	GLYPH,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@octocodeai/octocode-tui";
import { getModelSearchText } from "../model-search.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import {
	clearAll,
	enableAll,
	type EnabledIds,
	getSortedIds,
	isEnabled,
	move,
	toggle,
} from "./scoped-models-selector/enabled-ids.ts";
import { plainText } from "./styled-line.ts";
import { providerBadge } from "./model-selector/rows.ts";
import type { ProviderKind } from "../../../core/model-runtime/catalog.ts";

interface ModelItem {
	fullId: string;
	model: Model<any> | undefined;
	enabled: boolean;
}

interface ModelsConfig {
	allModels: Model<any>[];
	enabledModelIds: string[] | null;
	refreshStatus?: string;
	/** Each provider's kind for its badge (`ModelRuntime.getProviderKind`); without it the badge names the provider only. */
	providerKind?: (provider: string) => ProviderKind;
}

interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * Component for enabling/disabling models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<any>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private filteredItems: ModelItem[] = [];
	private selectedIndex = 0;
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
	private footerText: Text;
	private callbacks: ModelsCallbacks;
	private providerKind: ModelsConfig["providerKind"];
	private maxVisible = 8;
	private isDirty = false;
	private refreshStatusText?: Text;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;
		this.providerKind = config.providerKind;

		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.filteredItems = this.buildItems();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("accent", theme.bold("Model shortcuts — choose models for keyboard cycling")), 0, 0),
		);
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		if (config.refreshStatus) {
			this.refreshStatusText = new Text(theme.fg("muted", `  ${plainText(config.refreshStatus)}`), 0, 0);
			this.addChild(this.refreshStatusText);
		}
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());
		this.updateList();
	}

	updateModels(models: readonly Model<any>[], enabledModelIds?: string[] | null): void {
		const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
		this.refresh();
		if (selectedId) this.select(selectedId);
	}

	/** Keep `fullId` selected after the list was rebuilt, when it is still listed. */
	private select(fullId: string): void {
		const index = this.filteredItems.findIndex((item) => item.fullId === fullId);
		if (index >= 0 && index !== this.selectedIndex) {
			this.selectedIndex = index;
			this.updateList();
		}
	}

	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		// The message can carry a refresh error's text.
		this.refreshStatusText?.setText(theme.fg(kind, `  ${plainText(message)}`));
	}

	private buildItems(): ModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled
			? "all enabled"
			: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("app.models.enableAll")} all`,
			`${keyText("app.models.clearAll")} clear`,
			`${keyText("app.models.toggleProvider")} provider`,
			`${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")} reorder`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query
			? fuzzyFilter(items, query, (item) =>
					item.model
						? getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
						: item.fullId,
				)
			: items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private notifyChange(): void {
		void this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
			// Model ids, names and providers can come from vendor model lists and the remote catalog.
			const id = plainText(item.model?.id ?? item.fullId);
			const styledId = item.model ? id : theme.strikethrough(id);
			const modelText = isSelected ? theme.fg("accent", styledId) : styledId;
			const provider = item.model?.provider;
			const badge = provider ? providerBadge(plainText(provider), this.providerKind?.(provider)) : "[unavailable]";
			const providerText = theme.fg("muted", ` ${badge}`);
			const status = item.model && item.enabled ? theme.fg("accent", "✓ ") : "  ";
			this.listContainer.addChild(new Text(`${prefix}${status}${modelText}${providerText}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}

		if (this.filteredItems.length > 0) {
			const selected = this.filteredItems[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(
					theme.fg(
						"muted",
						`  ${selected.model ? `Model Name: ${plainText(selected.model.name)}` : "Model unavailable"}`,
					),
					0,
					0,
				),
			);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return;
			const item = this.filteredItems[this.selectedIndex];
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					this.isDirty = true;
					this.refresh();
					// A search hides some models, so the moved one need not be one row away: follow it by id.
					this.select(item.fullId);
					this.notifyChange();
				}
			}
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.enabledIds = toggle(this.enabledIds, this.allIds, item.fullId);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Enable all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Clear all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item?.model) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		if (kb.matches(data, "app.models.save")) {
			void this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
