import { type Component, truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import { providerAccessLabel } from "../../../../core/provider-label.ts";
import type { ModelRuntime } from "../../../../core/model-runtime.ts";
import { positionLabel } from "../../../../theme/page-kit.ts";
import { hintText, keyText } from "../../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../../theme/theme.ts";
import { compactModelDetails, modelDetails, userSetPrice } from "./details.ts";
import type { ModelItem } from "./model-items.ts";

/** What the panel under the model list shows: the highlighted model's facts and the catalog refresh status. */
export interface ModelPanelView {
	selected?: ModelItem;
	runtime: ModelRuntime;
	/** The full pricing and cache details instead of the two compact lines. */
	details: boolean;
	/** The open details offer the key that saves the highlighted model as its provider's preferred model. */
	canPrefer: boolean;
	/** What switching to the highlighted model rewrites in the cache; absent when nothing is rewritten. */
	switchNotice?: string;
	error?: string;
	refresh: string;
	refreshed: boolean;
}

/** The action the details offer, as the switch question named it before Enter switched directly. */
const PREFER_LABEL = "set as this provider’s preferred model";

/** Detail lines in view at once; page keys scroll the rest. */
const DETAIL_ROWS = 5;

/**
 * The facts under the model list; the full details scroll by page keys with their own `a–b/total`, and name the key
 * that makes the model its provider's preferred one.
 */
export class ModelDetailPanel implements Component {
	private offset = 0;
	private readonly view: () => ModelPanelView;

	constructor(view: () => ModelPanelView) {
		this.view = view;
	}

	/** Back to the first detail line, as when the details open. */
	reset(): void {
		this.offset = 0;
	}

	/** Scroll the full details by `delta` lines; clamped when drawn. */
	scroll(delta: number): void {
		this.offset = Math.max(0, this.offset + delta);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const view = this.view();
		const lines: string[] = [];
		const selected = view.selected;
		if (selected) {
			lines.push("");
			const kind = providerAccessLabel(view.runtime, selected.provider);
			const billing = view.runtime.getProviderBilling(selected.provider);
			const details = view.details
				? modelDetails(selected.model, Date.now(), kind, billing, userSetPrice(view.runtime, selected.model))
						.split("\n")
						.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
				: compactModelDetails(selected.model, kind, billing);
			const count = view.details ? DETAIL_ROWS : details.length;
			this.offset = Math.max(0, Math.min(this.offset, details.length - count));
			for (const line of details.slice(this.offset, this.offset + count))
				lines.push(theme.fg("muted", truncateToWidth(line, width, "…")));
			if (view.details && details.length > count) {
				const range = positionLabel(this.offset + 1, Math.min(details.length, this.offset + count), details.length);
				const keys = hintText([[`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`, "details"]]);
				lines.push(theme.fg("muted", truncateToWidth(` ${range} · ${keys}`, width, "…")));
			}
			if (view.details && view.canPrefer) {
				const prefer = hintText([[keyText("app.models.preferred"), PREFER_LABEL]]);
				lines.push(theme.fg("muted", truncateToWidth(` ${prefer}`, width, "…")));
			}
		}
		if (view.switchNotice) lines.push(theme.fg("warning", truncateToWidth(` ${view.switchNotice}`, width, "…")));
		if (view.error) lines.push(theme.fg("warning", truncateToWidth(` ${view.error}`, width, "…")));
		else if (view.refresh)
			lines.push(theme.fg(view.refreshed ? "success" : "muted", truncateToWidth(` ${view.refresh}`, width, "…")));
		return lines;
	}
}
