import type { Component } from "@octocodeai/octocode-tui";
import { keyText, renderHintLine, type RankedHint } from "../../../../theme/theme-tui-helpers.ts";

export class ModelPickerHints implements Component {
	private readonly canSave: boolean;
	constructor(canSave: boolean) {
		this.canSave = canSave;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const select: RankedHint = [keyText("tui.select.confirm"), "this chat", 0];
		const save: RankedHint = [keyText("app.models.save"), "global default", 0];
		const details: RankedHint = [keyText("app.models.details"), "details", 1];
		const cancel: RankedHint = [keyText("tui.select.cancel"), "back", 0];
		const choices = this.canSave ? [select, save] : [select];
		return width < 72
			? [renderHintLine(choices, width), renderHintLine([details, cancel], width)]
			: [renderHintLine([...choices, details, cancel], width)];
	}
}
