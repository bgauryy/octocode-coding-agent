/**
 * The editor slot that dialogs and non-overlay custom components share: one holder at a time, and a holder is answered
 * with no value when another takes the slot or the reset on reload or session replacement closes it.
 */

import type { InteractiveModeHost } from "./host.ts";

/**
 * The open dialog's cancel, per host. Selectors, inputs and the editor share the editor slot, so one is open at a time:
 * opening another or hiding it from outside (`resetFeatureUI` on reload or session replacement) answers it with no
 * value, instead of leaving its caller and the dialog queue (`withDialog`) waiting for an answer nobody can give.
 */
const openDialogs = new WeakMap<object, () => void>();

export function takeOpenDialog(host: object): (() => void) | undefined {
	const cancel = openDialogs.get(host);
	openDialogs.delete(host);
	return cancel;
}

export type SlotHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "activeStatusIndicator"
	| "clearStatusIndicator"
	| "disposeActiveSelector"
	| "session"
	| "uiStore"
>;

/**
 * Take the editor slot for a dialog or a non-overlay custom component. Whatever holds it (a feature dialog, a
 * built-in selector or another custom component) is answered or disposed first, and `cancel` becomes the slot's
 * dispose, so whatever takes the slot next through `disposeActiveSelector` (a dialog, `showSelector`, a custom component,
 * a custom editor, the reset on reload or session replacement, or stop) answers this one with no value. Returns the
 * release to call when it closes by itself.
 */
export function takeSlot(host: SlotHost, cancel: () => void): () => void {
	takeOpenDialog(host)?.();
	host.disposeActiveSelector();
	// Enter shows "Working" before a command runs; a page that opens with no run behind it is not working.
	if (host.activeStatusIndicator?.kind === "working" && !host.session.isStreaming) host.clearStatusIndicator("working");
	const token = {};
	host.uiStore.getState().takeSlot(token);
	host.activeSelectorDispose = cancel;
	return () => {
		if (!host.uiStore.getState().releaseSlot(token)) return;
		host.activeSelectorDispose = undefined;
	};
}

/**
 * Answer the open dialog, then register a new one in the editor slot; the result settles it once, releases the slot,
 * hides it and stops listening to `signal`.
 */
export function openDialog<T>(
	host: SlotHost,
	resolve: (value: T | undefined) => void,
	hide: () => void,
	signal: AbortSignal | undefined,
): (value: T | undefined) => void {
	let done = false;
	const finish = (value: T | undefined) => {
		if (done) return;
		done = true;
		signal?.removeEventListener("abort", cancel);
		if (openDialogs.get(host) === cancel) openDialogs.delete(host);
		release();
		hide();
		resolve(value);
	};
	const cancel = () => finish(undefined);
	const release = takeSlot(host, cancel);
	signal?.addEventListener("abort", cancel, { once: true });
	openDialogs.set(host, cancel);
	return finish;
}
