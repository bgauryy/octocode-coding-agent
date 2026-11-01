import type { Component } from "@octocodeai/octocode-tui";
import { Box, Container, Spacer, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../../../theme/theme.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
export class CustomEntryComponent extends Container {
	private entry: CustomEntry;
	private renderer: EntryRenderer;
	private customComponent?: Component;
	private _expanded = false;
	private outputPad: number;

	constructor(entry: CustomEntry, renderer: EntryRenderer, outputPad = 1) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		this.outputPad = outputPad;
		this.rebuild();
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	override render(width: number): string[] {
		try {
			return super.render(width);
		} catch (error) {
			return new Text(theme.fg("error", this.failure(error)), this.outputPad, 0).render(width);
		}
	}

	/** The one renderer-failure line: the entry's type and the error both come from session data, so both are cleaned. */
	private failure(error: unknown): string {
		return sanitizeTerminalText(`[${this.entry.customType}] renderer failed: ${errorMessage(error)}`);
	}

	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;

		let component: Component | undefined;
		try {
			component = this.renderer(this.entry, { expanded: this._expanded }, theme);
		} catch (error) {
			const box = new Box(this.outputPad, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("error", this.failure(error)), 0, 0));
			component = box;
		}

		if (!component) {
			return;
		}

		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}
