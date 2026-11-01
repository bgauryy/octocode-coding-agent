/**
 * Render failures in the transcript. The TUI replaces a component that throws while painting with a one-line
 * fallback and reports the error to `onRenderError`; interactive mode turns each distinct failure into one notice.
 */

import type { Component, RenderErrorListener } from "@octocodeai/octocode-tui";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { InteractiveModeHost } from "./host.ts";

/** Distinct failures shown per interactive run; later ones still get the TUI's inline fallback line. */
const MAX_NOTICES = 20;
const MAX_DETAIL_LENGTH = 200;

function componentName(component: Component): string {
	const name = (component as { constructor?: { name?: unknown } }).constructor?.name;
	return typeof name === "string" && name !== "" && name !== "Object" ? name : "Component";
}

/**
 * A render error listener that shows `Display failed: <Component> could not render: <first line>` once per distinct
 * component name and message. The notice is added after the frame, never while the tree is being painted, and a
 * notice that fails to show or to render cannot report itself again (its key is already taken).
 */
export function createRenderErrorNotices(
	show: (message: string) => void,
	schedule: (task: () => void) => void = queueMicrotask,
): RenderErrorListener {
	const shown = new Set<string>();
	return (error, component) => {
		const name = componentName(component);
		const firstLine = (errorMessage(error).split("\n", 1)[0] ?? "").slice(0, MAX_DETAIL_LENGTH);
		const key = `${name}\u0000${firstLine}`;
		if (shown.has(key) || shown.size >= MAX_NOTICES) return;
		shown.add(key);
		schedule(() => {
			try {
				// `showError` sanitizes the message for the terminal.
				show(`Display failed: ${name} could not render: ${firstLine}`);
			} catch {
				// The component already shows its inline fallback; a failing notice must not raise a new failure.
			}
		});
	};
}

/** Report render failures of the active renderer in the transcript; `switchTuiMode` carries the listener over. */
export function installRenderErrorNotices(host: Pick<InteractiveModeHost, "renderer" | "showError">): void {
	host.renderer.onRenderError = createRenderErrorNotices((message) => host.showError(message));
}
