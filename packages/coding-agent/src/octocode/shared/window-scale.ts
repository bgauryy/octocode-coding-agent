/**
 * Sizes that grow with the model's context window. Each such size has a floor (its value for a window of
 * `REFERENCE_WINDOW_TOKENS` or less, or an unknown window) and grows in proportion to a larger window, up to
 * `MAX_WINDOW_SCALE` times the floor, so a small model never gets less than the floor and a huge window does not
 * flood the prompt.
 */
const REFERENCE_WINDOW_TOKENS = 200_000;
const MAX_WINDOW_SCALE = 5;

/** How many times its floor a size grows for `contextWindow` tokens: 1 for an unknown or reference-sized window. */
function windowScale(contextWindow: number | undefined): number {
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= REFERENCE_WINDOW_TOKENS) return 1;
	return Math.min(MAX_WINDOW_SCALE, contextWindow / REFERENCE_WINDOW_TOKENS);
}

/** `floor`, grown for the window (whole numbers, never below the floor). */
export function scaledByWindow(floor: number, contextWindow: number | undefined): number {
	return Math.ceil(floor * windowScale(contextWindow));
}
