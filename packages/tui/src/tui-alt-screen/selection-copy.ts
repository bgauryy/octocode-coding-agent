import type { Terminal } from "../terminal.ts";
import { COPY_ERROR_FLASH_DURATION_MS } from "./constants.ts";

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

/** What copying needs from the screen: an optional native clipboard, the terminal for OSC 52, and the flash line. */
interface ClipboardHost {
	readonly copySelection?: (text: string) => Promise<boolean | string>;
	flash(message: string, durationMs?: number): void;
	getTerminal(): Terminal;
}

/**
 * Copy text, preferring an injected clipboard with a verified success path: a bare OSC 52 write can show "Copied!"
 * while leaving the system clipboard untouched (macOS Terminal.app, tmux without passthrough), so success is reported
 * only when it actually copies.
 */
export async function copyTextToClipboard(host: ClipboardHost, text: string): Promise<boolean> {
	if (host.copySelection) {
		let result: boolean | string;
		try {
			result = await host.copySelection(text);
		} catch (error) {
			result = error instanceof Error ? error.message : "Copy failed";
		}
		const ok = result === true;
		host.flash(
			ok ? "Copied!" : typeof result === "string" ? result : "Copy failed",
			ok ? undefined : COPY_ERROR_FLASH_DURATION_MS,
		);
		return ok;
	}
	if (Buffer.byteLength(text) > TERMINAL_CLIPBOARD_BYTES) {
		host.flash("Copy failed: selection exceeds terminal clipboard limit", COPY_ERROR_FLASH_DURATION_MS);
		return false;
	}
	host.getTerminal().write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	host.flash("Copied!");
	return true;
}
