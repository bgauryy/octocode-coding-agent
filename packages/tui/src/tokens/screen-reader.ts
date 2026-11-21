/**
 * Screen-reader text mode: a process-wide switch the host sets from its settings. While on, live marks render as words
 * instead of spinner, shimmer and gauge glyphs, which a screen reader would read as noise or repaint noisily.
 */
let screenReader = false;

export function setScreenReaderMode(enabled: boolean): void {
	screenReader = enabled;
}

export function isScreenReaderMode(): boolean {
	return screenReader;
}
