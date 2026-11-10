let kittyProtocolActive = false;

/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export function setKittyProtocolActive(active: boolean): void {
	kittyProtocolActive = active;
}

/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export function isKittyProtocolActive(): boolean {
	return kittyProtocolActive;
}
