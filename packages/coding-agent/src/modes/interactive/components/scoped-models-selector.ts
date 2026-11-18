import type { Model } from "@octocodeai/octocode-ai";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	ListView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { getModelSearchText } from "../model-search.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { shortcutsFooter } from "./scoped-models-selector/footer.ts";
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
import { listRows, listTheme, syncEmpty } from "./list-kit.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

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
	providerKind?: (provider: string) => string;
	/** Terminal rows, for the list's height; without it the list shows eight rows. */
	rows?: number;
}

interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
	requestRender?: () => void;
}

/** Draws lines computed at the render width, each cut to it. */
class LinesView implements Component {
	private readonly lines: (width: number) => string[];
	constructor(lines: (width: number) => string[]) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.lines(width).map((line) => truncateToWidth(line, width, "…"));
	}
}

/**
 * Component for enabling/disabling models for Ctrl+P cycling: a `⌕` search over the models, Enter toggles the
 * highlighted one. Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<any>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private readonly list: ListView<ModelItem>;
	get focused(): boolean {
		return this.list.focused;
	}
	set focused(value: boolean) {
		this.list.focused = value;
	}
	private callbacks: ModelsCallbacks;
	private providerKind: ModelsConfig["providerKind"];
	private isDirty = false;
	private refreshStatusText?: Text;
	private saving = false;
	private saveError?: string;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;
		this.providerKind = config.providerKind;
		this.setModels(config.allModels);
		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];

		this.list = new ListView<ModelItem>({
			items: this.buildItems(),
			maxRows: listRows(config.rows, 14, 8),
			theme: listTheme(),
			search: {
				text: (item) =>
					item.model
						? getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
						: item.fullId,
				placeholder: "type to search",
			},
			row: (item, state) => this.row(item, state),
		});
		this.list.onSelect = (item) => {
			this.enabledIds = toggle(this.enabledIds, this.allIds, item.fullId);
			this.changed();
		};
		this.list.onCancel = () => this.callbacks.onCancel();
		syncEmpty(this.list, "models");

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Model shortcuts")), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} saves globally.`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new LinesView(() => this.selectedLines()));
		this.addChild(new Spacer(1));
		if (config.refreshStatus) {
			this.refreshStatusText = new Text(theme.fg("muted", plainText(config.refreshStatus)), 1, 0);
			this.addChild(this.refreshStatusText);
		}
		this.addChild(new LinesView((width) => this.footerLines(width)));
		this.addChild(new DynamicBorder());
	}

	private setModels(models: readonly Model<any>[]): void {
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
	}

	updateModels(models: readonly Model<any>[], enabledModelIds?: string[] | null): void {
		const selectedId = this.list.getSelectedItem()?.fullId;
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.setModels(models);
		this.refresh();
		if (selectedId) this.select(selectedId);
	}

	/** Keep `fullId` selected after the list was rebuilt, when it is still listed. */
	private select(fullId: string): void {
		const index = this.list.getItems().findIndex((item) => item.fullId === fullId);
		if (index >= 0) this.list.setSelectedIndex(index);
	}

	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		// The message can carry a refresh error's text.
		this.refreshStatusText?.setText(theme.fg(kind, plainText(message)));
	}

	private buildItems(): ModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	/** The enabled mark, the id (struck through when unavailable) and the provider badge, cut to `width`. */
	private row(item: ModelItem, state: { selected: boolean; width: number }): string {
		// Model ids, names and providers can come from vendor model lists and the remote catalog.
		const id = plainText(item.model?.id ?? item.fullId);
		const styledId = item.model ? id : theme.strikethrough(id);
		const modelText = state.selected ? theme.fg("accent", theme.bold(styledId)) : styledId;
		const provider = item.model?.provider;
		const badge = provider ? providerBadge(plainText(provider), this.providerKind?.(provider)) : "[unavailable]";
		const providerText = theme.fg("muted", ` ${badge}`);
		const status = item.model && item.enabled ? theme.fg("accent", "✓ ") : "  ";
		const badgeRoom = item.model ? Math.min(24, Math.floor(state.width / 3)) : visibleWidth(providerText);
		const clippedBadge = truncateToWidth(providerText, Math.max(0, Math.min(state.width - 2, badgeRoom)), "…");
		const label = truncateToWidth(modelText, Math.max(0, state.width - 2 - visibleWidth(clippedBadge)), "…");
		return truncateToWidth(`${status}${label}${clippedBadge}`, state.width, "…");
	}

	/** The highlighted model's name and provider under the list. */
	private selectedLines(): string[] {
		const selected = this.list.getSelectedItem();
		if (!selected) return [];
		const text = selected.model
			? `${plainText(selected.model.name)} · ${providerBadge(plainText(selected.model.provider), this.providerKind?.(selected.model.provider))}`
			: `Unavailable: ${plainText(selected.fullId)}`;
		return ["", theme.fg("muted", `  ${text}`)];
	}

	private footerLines(width: number): string[] {
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const countText =
			this.enabledIds === null
				? "all enabled"
				: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		return shortcutsFooter(countText, width, {
			dirty: this.isDirty,
			saving: this.saving,
			error: this.saveError,
			empty: this.list.getItems().length === 0,
		});
	}

	/** Rebuild the rows from the enabled set; the cursor keeps its index, clamped. */
	private refresh(): void {
		this.list.setItems(this.buildItems());
		syncEmpty(this.list, "models");
	}

	private changed(): void {
		this.isDirty = true;
		this.refresh();
		void this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	/** The ids a bulk key acts on: the search's matches while it searches, otherwise every model. */
	private bulkTargets(): string[] | undefined {
		return this.list.getQuery() ? this.list.getItems().map((item) => item.fullId) : undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.saving && !kb.matches(data, "tui.select.cancel")) return;
		const item = this.list.getSelectedItem();

		const reorderUp = kb.matches(data, "app.models.reorderUp");
		if (reorderUp || kb.matches(data, "app.models.reorderDown")) {
			if (this.enabledIds === null || !item || !isEnabled(this.enabledIds, item.fullId)) return;
			const delta = reorderUp ? -1 : 1;
			const newIndex = this.enabledIds.indexOf(item.fullId) + delta;
			if (newIndex < 0 || newIndex >= this.enabledIds.length) return;
			this.enabledIds = move(this.enabledIds, item.fullId, delta);
			this.changed();
			// A search hides some models, so the moved one need not be one row away: follow it by id.
			this.select(item.fullId);
			return;
		}
		if (kb.matches(data, "app.models.enableAll")) {
			this.enabledIds = enableAll(this.enabledIds, this.allIds, this.bulkTargets());
			return this.changed();
		}
		if (kb.matches(data, "app.models.clearAll")) {
			this.enabledIds = clearAll(this.enabledIds, this.allIds, this.bulkTargets());
			return this.changed();
		}
		if (kb.matches(data, "app.models.toggleProvider")) {
			if (!item?.model) return;
			const provider = item.model.provider;
			const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
			const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
			this.enabledIds = allEnabled
				? clearAll(this.enabledIds, this.allIds, providerIds)
				: enableAll(this.enabledIds, this.allIds, providerIds);
			return this.changed();
		}
		if (kb.matches(data, "app.models.save")) {
			void this.persist();
			return;
		}
		// Enter toggles, Esc clears the search first and then closes, the rest moves or searches.
		this.list.handleInput(data);
		syncEmpty(this.list, "models");
	}

	/** The search text the list filters by. */
	getQuery(): string {
		return this.list.getQuery();
	}

	private async persist(): Promise<void> {
		this.saving = true;
		this.saveError = undefined;
		try {
			await this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
		} catch (error) {
			this.saveError = `Could not save shortcuts: ${errorMessage(error)}`;
		} finally {
			this.saving = false;
			this.callbacks.requestRender?.();
		}
	}
}
