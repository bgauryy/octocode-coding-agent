/**
 * Whether the terminal UI currently owns the screen: between `ProcessTerminal.start()` and `stop()` (a suspend, a
 * crash report and an exit all stop it). Anything else that writes to the terminal, such as `console.*`, would land in
 * the middle of the frame while this is true.
 */
export type ScreenOwnerListener = (owned: boolean) => void;

let owned = false;
const listeners = new Set<ScreenOwnerListener>();

export function setScreenOwned(next: boolean): void {
	if (owned === next) return;
	owned = next;
	for (const listener of listeners) listener(next);
}

export function isScreenOwned(): boolean {
	return owned;
}

/** Calls `listener` on every change of ownership; returns the function that removes it. */
export function onScreenOwnerChange(listener: ScreenOwnerListener): () => void {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}
