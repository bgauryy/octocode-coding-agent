import {
	type Component,
	Container,
	ListView,
	type SelectItem,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { HintBar, keyText, moveHint, type RankedHint } from "../../../theme/theme-tui-helpers.ts";
import { columnRow, labelColumn, listTheme, syncEmpty } from "./list-kit.ts";
import { plainText } from "./styled-line.ts";

const SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

interface SelectSubmenuOptions {
	/** Enable type-to-search fuzzy filtering. */
	searchable?: boolean;
	/** Override the select list layout (column widths). */
	layout?: SelectListLayoutOptions;
}

/**
 * A one-step picker: title, optional description, and its options on `ListView` (`›` cursor, ends that stop, page
 * keys, `a–b/total` while it scrolls). With `searchable: true` a `⌕` line filters by label and description; Esc clears
 * the query, then goes back. A click selects and a click on the selected option picks it.
 */
export class SelectSubmenu extends Container {
	private readonly list: ListView<SelectItem>;
	private readonly hints: HintBar;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		submenuOptions?: SelectSubmenuOptions,
	) {
		super();
		const layout = submenuOptions?.layout ?? SUBMENU_SELECT_LIST_LAYOUT;
		// A label's leading spaces align it under a `✓ ` mark (theme, thinking level); `plainText` would trim them.
		const indent = (label: string) => /^ */.exec(label)?.[0] ?? "";
		const column = labelColumn(
			options.map((option) => `${indent(option.label).replace(/ /g, "_")}${option.label.trim()}`),
			layout.minPrimaryColumnWidth ?? 12,
			layout.maxPrimaryColumnWidth ?? 32,
		);

		// Title and description: a step's title can name a model from a vendor list (per-model thinking).
		this.addChild(new Text(theme.bold(theme.fg("accent", plainText(title))), 0, 0));

		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", plainText(description)), 0, 0));
		}

		this.addChild(new Spacer(1));
		this.list = new ListView<SelectItem>({
			items: options,
			maxRows: Math.max(1, Math.min(options.length, 10)),
			theme: listTheme(),
			...(submenuOptions?.searchable
				? {
						search: {
							text: (item: SelectItem) => `${item.label} ${item.description ?? ""}`,
							placeholder: "type to filter",
						},
					}
				: {}),
			row: (item, state) => {
				const pad = indent(item.label);
				const inner = { selected: state.selected, width: Math.max(1, state.width - pad.length) };
				return pad + columnRow(item.label, item.description, inner, Math.max(1, column - pad.length));
			},
		});
		const preselected = options.findIndex((option) => option.value === currentValue);
		if (preselected !== -1) this.list.setSelectedIndex(preselected);
		this.list.onSelect = (item) => onSelect(item.value);
		this.list.onCancel = onCancel;
		if (onSelectionChange) this.list.onSelectionChange = (item) => onSelectionChange(item.value);
		syncEmpty(this.list, "options");
		this.addChild(this.list);

		this.addChild(new Spacer(1));
		this.hints = new HintBar(this.hintKeys());
		this.addChild(this.hints);
	}

	/** Enter's verb first, Esc's last; with nothing shown only Esc remains (the empty line names `esc clears`). */
	private hintKeys(): RankedHint[] {
		const back: RankedHint = [keyText("tui.select.cancel"), "back", 0];
		if (!this.list.getSelectedItem()) return [back];
		return [[keyText("tui.select.confirm"), "select", 1], moveHint(), back];
	}

	handleInput(data: string): void {
		const query = this.list.getQuery();
		this.list.handleInput(data);
		if (this.list.getQuery() === query) return;
		// A new query highlights its best match.
		this.list.setSelectedIndex(0);
		syncEmpty(this.list, "options");
		this.hints.setHints(this.hintKeys());
	}
}

// SteppedSubmenu — reusable multi-step selector

export interface SteppedSubmenuStep {
	/** Unique key \u2014 the selected value is stored in the result context under this key. */
	key: string;
	/** Title shown at the top of the step. Receives prior selections. */
	title: string | ((context: Record<string, string>) => string);
	/** Description shown below the title. Receives prior selections. */
	description: string | ((context: Record<string, string>) => string);
	/** Build the option list for this step. Called fresh each time the step is shown. */
	options: (context: Record<string, string>) => SelectItem[];
	/** Optionally pre-select a value when entering this step. */
	preselect?: (context: Record<string, string>) => string | undefined;
	/** Enable type-to-search fuzzy filtering for this step. */
	searchable?: boolean;
	/** Override the select list layout (column widths) for this step. */
	layout?: SelectListLayoutOptions;
}

interface SteppedSubmenuOptions {
	/** Start at this step index (0-based), skipping earlier steps. Requires initialContext for skipped keys. */
	startAtStep?: number;
	/** Pre-fill selections for skipped steps. */
	initialContext?: Record<string, string>;
	/** After completing the last step, loop back to step 0 instead of closing. */
	loop?: boolean;
}

/**
 * Generic N-step submenu built on top of {@link SelectSubmenu}.
 *
 * Each step's options can depend on prior selections via the shared context.
 * Esc goes back one step; Esc at step 0 cancels.
 * With `loop: true`, completing the final step invokes `onComplete` then returns to step 0.
 */
export class SteppedSubmenu extends Container {
	private readonly steps: SteppedSubmenuStep[];
	private readonly onComplete: (context: Record<string, string>) => void;
	private readonly onCancel: () => void;
	private readonly opts: SteppedSubmenuOptions;
	private activeComponent: Component = new Container();
	private context: Record<string, string>;

	constructor(
		steps: SteppedSubmenuStep[],
		onComplete: (context: Record<string, string>) => void,
		onCancel: () => void,
		opts: SteppedSubmenuOptions = {},
	) {
		super();
		this.steps = steps;
		this.onComplete = onComplete;
		this.onCancel = onCancel;
		this.opts = opts;
		this.context = { ...opts.initialContext };
		this.show(this.buildStep(opts.startAtStep ?? 0));
	}

	/** The step on screen; it is this container's only child, so mouse events reach it. */
	private show(step: Component): void {
		this.activeComponent = step;
		this.clear();
		this.addChild(step);
	}

	private buildStep(stepIndex: number): Component {
		const step = this.steps[stepIndex];
		const total = this.steps.length;
		const stepLabel = total > 1 ? `Step ${stepIndex + 1}/${total} \u00b7 ` : "";

		const title = typeof step.title === "function" ? step.title(this.context) : step.title;
		const desc = typeof step.description === "function" ? step.description(this.context) : step.description;
		const items = step.options(this.context);
		const preselect = step.preselect?.(this.context) ?? "";

		return new SelectSubmenu(
			title,
			`${stepLabel}${desc}`,
			items,
			preselect,
			(value) => {
				this.context[step.key] = value;

				if (stepIndex < total - 1) {
					this.show(this.buildStep(stepIndex + 1));
				} else {
					// Final step \u2014 deliver result
					this.onComplete({ ...this.context });

					if (this.opts.loop) {
						this.context = {};
						this.show(this.buildStep(0));
					} else {
						this.onCancel();
					}
				}
			},
			() => {
				if (stepIndex > 0) {
					delete this.context[step.key];
					this.show(this.buildStep(stepIndex - 1));
				} else {
					this.onCancel();
				}
			},
			undefined,
			step.searchable || step.layout ? { searchable: step.searchable, layout: step.layout } : undefined,
		);
	}

	render(width: number): string[] {
		return this.activeComponent.render(width);
	}

	handleInput(data: string): void {
		this.activeComponent.handleInput?.(data);
	}

	invalidate(): void {
		this.activeComponent.invalidate?.();
	}
}
