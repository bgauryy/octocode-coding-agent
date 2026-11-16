/** 100,000 base64 characters: the fallback terminal clipboard's existing transfer limit. */
export const TERMINAL_CLIPBOARD_BYTES = 75_000;

/** The most selected text handed whole to an injected (native) clipboard. */
export const NATIVE_CLIPBOARD_BYTES = 8 * 1024 * 1024;

/** Longest run of selection rows extracted before yielding to the event loop. */
const EXTRACTION_SLICE_MS = 8;
const EXTRACTION_CLOCK_ROWS = 64;

/**
 * Join selected rows in time slices, yielding between them so input and timers keep running.
 * Stops as soon as the byte total passes `limitBytes`, and reports a superseded run instead of dropping it.
 */
export async function collectSelectionText(
	rows: Iterable<string>,
	limitBytes: number,
	isSuperseded: () => boolean,
): Promise<{ text?: string; error?: string }> {
	const lines: string[] = [];
	let bytes = 0;
	let sliceStart = performance.now();
	for (const line of rows) {
		bytes += Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
		if (bytes > limitBytes) {
			return {
				error:
					limitBytes === NATIVE_CLIPBOARD_BYTES
						? "Copy failed: selection too large to copy"
						: "Copy failed: selection exceeds terminal clipboard limit",
			};
		}
		lines.push(line);
		if (lines.length % EXTRACTION_CLOCK_ROWS === 0 && performance.now() - sliceStart >= EXTRACTION_SLICE_MS) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (isSuperseded()) return { error: "Copy cancelled: a newer copy started" };
			sliceStart = performance.now();
		}
	}
	return { text: lines.join("\n") };
}
