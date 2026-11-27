import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type Component, Container, type TUI } from "@octocodeai/octocode-tui";

/** Only output and selectors created by this browser command belong to its response. Ordinary terminal work stays separate. */
export interface CommandCapture {
	owner: symbol;
	ui: TUI;
	focused(): Component | null;
	transcript: Container;
	output: Component[];
	dialog?: { id: string; component: Component; focus: Component };
}
export const webCommandContext = new AsyncLocalStorage<CommandCapture>();

export function captureCommandDialog(ui: TUI, component: Component, focus = component): void {
	const capture = webCommandContext.getStore();
	if (capture?.ui === ui) capture.dialog = { id: randomUUID(), component, focus };
}

export class CommandTranscript extends Container {
	override addChild(component: Component): void {
		super.addChild(component);
		const capture = webCommandContext.getStore();
		if (capture?.transcript === this) {
			capture.output.push(component);
			if (capture.output.length > 16) capture.output.shift();
		}
	}
}
