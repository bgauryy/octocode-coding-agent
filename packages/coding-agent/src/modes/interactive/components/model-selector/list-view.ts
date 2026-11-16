import {
	type Container,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { modelsAreEqual, type Model } from "@octocodeai/octocode-ai";
import { providerAccessLabel } from "../../../../core/provider-label.ts";
import type { ModelRuntime } from "../../../../core/model-runtime.ts";
import { positionLabel } from "../../../../theme/page-kit.ts";
import { hintText, keyText } from "../../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../../theme/theme.ts";
import { compactModelDetails, modelDetails } from "./details.ts";
import { emptyModelListText } from "./empty-state.ts";
import { isDefaultModel, type DefaultModelReference, type ModelItem } from "./model-items.ts";
import { modelListLines } from "./rows.ts";

interface ModelListView {
	items: ModelItem[];
	selectedIndex: number;
	currentModel?: Model<any>;
	defaultModel?: DefaultModelReference;
	runtime: ModelRuntime;
	width: number;
	details: boolean;
	detailOffset: number;
	searched: boolean;
	scoped: boolean;
	error?: string;
	refresh: string;
	refreshed: boolean;
}

export function updateModelList(container: Container, view: ModelListView): number {
	container.clear();
	let offset = 0;
	for (const line of modelListLines(
		view.items,
		view.selectedIndex,
		(item) => ({
			current: modelsAreEqual(view.currentModel, item.model),
			isDefault: isDefaultModel(view.defaultModel, item.model),
			kind: providerAccessLabel(view.runtime, item.provider),
		}),
		view.details ? 1 : 3,
		view.width,
	))
		container.addChild(new Text(line, 0, 0));
	const selected = view.items[view.selectedIndex];
	if (!selected) {
		const empty =
			view.scoped && !view.searched
				? "No available scoped shortcuts. Switch to all models to choose another."
				: emptyModelListText(view.runtime, view.searched);
		container.addChild(new Text(theme.fg("muted", ` ${empty}`), 0, 0));
	} else {
		container.addChild(new Spacer(1));
		const kind = providerAccessLabel(view.runtime, selected.provider);
		const billing = view.runtime.getProviderBilling(selected.provider);
		const details = view.details
			? modelDetails(selected.model, Date.now(), kind, billing)
					.split("\n")
					.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, view.width)))
			: compactModelDetails(selected.model, kind, billing).map((line) => truncateToWidth(line, view.width, "…"));
		const count = view.details ? 5 : details.length;
		offset = Math.max(0, Math.min(view.detailOffset, details.length - count));
		for (const line of details.slice(offset, offset + count))
			container.addChild(new Text(theme.fg("muted", line), 0, 0));
		if (view.details && details.length > count)
			container.addChild(
				new TruncatedText(
					theme.fg(
						"muted",
						` ${positionLabel(offset + 1, Math.min(details.length, offset + count), details.length)} · ${hintText([[`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`, "details"]])}`,
					),
					0,
					0,
				),
			);
	}
	if (view.error) container.addChild(new TruncatedText(theme.fg("warning", view.error), 0, 0));
	else if (view.refresh)
		container.addChild(new Text(theme.fg(view.refreshed ? "success" : "muted", ` ${view.refresh}`), 0, 0));
	return offset;
}
