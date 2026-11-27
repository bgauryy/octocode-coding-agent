/** A caller's lifecycle hint must never interrupt its child's report or cleanup. */
export function hint(hook: (() => void) | undefined): void {
	try {
		hook?.();
	} catch {
		// Hooks only tune waits and display state.
	}
}
