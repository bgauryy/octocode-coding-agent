import type { Component } from "@octocodeai/octocode-tui";
import { pageHints } from "../../../../theme/page-kit.ts";
import { keyText, renderHintLine } from "../../../../theme/theme-tui-helpers.ts";

export class ModelPickerHints implements Component {
	private readonly canSave: boolean;
	constructor(canSave: boolean) {
		this.canSave = canSave;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const hints = pageHints("picker", {
			nested: true,
			rowKeys: {
				...(this.canSave ? { [keyText("app.models.save")]: "set default" } : {}),
				[keyText("app.models.details")]: "details",
			},
		});
		// Enter and the save key lead; on a narrow terminal the rest moves to a second line.
		const lead = this.canSave ? 2 : 1;
		return width < 72
			? [renderHintLine(hints.slice(0, lead), width), renderHintLine(hints.slice(lead), width)]
			: [renderHintLine(hints, width)];
	}
}
