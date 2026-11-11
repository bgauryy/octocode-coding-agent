import { decodePastedControlKeys } from "../../paste-control-keys.ts";
import { stripControlCharacters } from "../../utils/chars.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A bracketed paste chunk the buffer consumed; `content` is set once the end marker arrived. */
interface BracketedPasteChunk {
	content?: string;
	/** Input after the end marker, to be handled as ordinary input. */
	remaining: string;
}

/** Bracketed paste mode buffering for the single-line input and the editor. */
export class BracketedPasteBuffer {
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	/** Feed one input chunk; returns undefined when the chunk is not part of a paste. */
	take(chunk: string): BracketedPasteChunk | undefined {
		let data = chunk;
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		if (data.includes(PASTE_START)) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace(PASTE_START, "");
		}

		// If we're in a paste, buffer the data
		if (!this.isInPaste) return undefined;

		// Check if this chunk contains the end marker
		this.pasteBuffer += data;

		const endIndex = this.pasteBuffer.indexOf(PASTE_END);
		if (endIndex === -1) return { remaining: "" };

		const content = this.pasteBuffer.substring(0, endIndex);

		this.isInPaste = false;

		// Keep any remaining input after the paste marker
		const remaining = this.pasteBuffer.substring(endIndex + PASTE_END.length);
		this.pasteBuffer = "";
		return { content, remaining };
	}
}

/**
 * Pasted text for a single-line input: tmux-encoded control keys decoded, line breaks dropped, tabs expanded, and
 * other control characters removed, as typed input rejects them; left in, they would reach the terminal on render.
 */
export function singleLinePaste(text: string): string {
	return stripControlCharacters(
		decodePastedControlKeys(text)
			.replace(/\r\n|\r|\n/g, "")
			.replace(/\t/g, "    "),
	);
}
