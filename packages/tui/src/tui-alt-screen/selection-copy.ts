import type { Terminal } from "../terminal.ts";
import { COPY_ERROR_FLASH_DURATION_MS } from "./constants.ts";
import { dedentSelectedLines, type SelectedLine } from "./selection-lines.ts";

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
	rows: Iterable<SelectedLine>,
	limitBytes: number,
	isSuperseded: () => boolean,
): Promise<{ text?: string; error?: string }> {
	const lines: SelectedLine[] = [];
	let bytes = 0;
	let sliceStart = performance.now();
	for (const line of rows) {
		// Counted before dedenting: dropping padding only shrinks the text.
		bytes += Buffer.byteLength(line.text) + (lines.length > 0 ? 1 : 0);
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
	return { text: dedentSelectedLines(lines).join("\n") };
}

/** What copying needs from the screen: an optional native clipboard, the terminal for OSC 52, and the flash line. */
interface ClipboardHost {
	readonly copySelection?: (text: string) => Promise<boolean | string>;
	flash(message: string, durationMs?: number): void;
	getTerminal(): Terminal;
	/** A hint to add to this confirmation, e.g. how to select with the terminal instead; shown once. */
	copyHint?(): string | undefined;
}

/** How long the hint after a confirmation stays up: long enough to read. */
const HINT_FLASH_DURATION_MS = 4000;

/** Code points in `text`, without building an array of them: a selection may be megabytes. */
function countCharacters(text: string): number {
	let count = text.length;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
			const previous = text.charCodeAt(index - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) count -= 1;
		}
	}
	return count;
}

/** How much text there is, as a copy confirmation says it: "3 lines · 1,204 chars", or "12 chars" for one line. */
export function copiedAmount(text: string): string {
	const characters = countCharacters(text);
	const chars = `${characters.toLocaleString("en-US")} ${characters === 1 ? "char" : "chars"}`;
	let lines = 1;
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
	return lines > 1 ? `${lines.toLocaleString("en-US")} lines · ${chars}` : chars;
}

/** The confirmation for copied text: how much went to the clipboard, e.g. "Copied 3 lines · 1,204 chars". */
export function copiedMessage(text: string): string {
	return `Copied ${copiedAmount(text)}`;
}

/** The confirmation, then (once) the hint on a row of its own, which stays longer: two short rows cover less. */
function flashCopied(host: ClipboardHost, text: string): void {
	host.flash(copiedMessage(text));
	const hint = host.copyHint?.();
	if (hint) host.flash(hint, HINT_FLASH_DURATION_MS);
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
		if (ok) flashCopied(host, text);
		else host.flash(typeof result === "string" ? result : "Copy failed", COPY_ERROR_FLASH_DURATION_MS);
		return ok;
	}
	if (Buffer.byteLength(text) > TERMINAL_CLIPBOARD_BYTES) {
		host.flash("Copy failed: selection exceeds terminal clipboard limit", COPY_ERROR_FLASH_DURATION_MS);
		return false;
	}
	host.getTerminal().write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	flashCopied(host, text);
	return true;
}
