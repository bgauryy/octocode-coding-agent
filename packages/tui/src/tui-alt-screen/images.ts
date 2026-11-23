import { getCapabilities, setCapabilities } from "../terminal-image/capabilities.ts";
import { KITTY_PLACEHOLDER } from "../terminal-image/kitty-placeholder.ts";
import type { ImageProtocol, TerminalCapabilities } from "../terminal-image/types.ts";
import { isImageLine } from "../terminal-image.ts";
import { stripTerminalSequences } from "../utils/ansi-codes.ts";
import { deleteKittyImagesFor } from "./kitty-cache.ts";
import type { CachedKittyImage } from "./types.ts";

/** Budget the encoded viewport before diffing or recording Kitty uploads. A recovery must also fit a full repaint. */
export function budgetImageRows(screen: string[], width: number, cap: number | undefined): string[] {
	if (cap === undefined) return screen;
	// Reserve room for erase, cursor addressing and mode changes. Ordinary frames need no UTF-8 scan.
	const available = cap - 256 - screen.length * 48;
	const units = screen.reduce((sum, row) => sum + row.length, 0);
	if (units * 3 <= available || !screen.some(isImageLine)) return screen;
	let excess = screen.reduce((sum, row) => sum + Buffer.byteLength(row), 0) - available;
	if (excess <= 0) return screen;
	const images = screen.flatMap((row, index) => (isImageLine(row) ? [{ row, index }] : []));
	// A tmux upload and all its placeholder cells are one placement, potentially across several rows.
	const placeholders = images.some(({ row }) => row.includes(KITTY_PLACEHOLDER));
	const bounded = [...screen];
	for (const { row, index } of images.sort((a, b) => b.row.length - a.row.length)) {
		if (!placeholders && excess <= 0) break;
		// Preserve text beside graphics, including a screenshot's separately rendered artifact path.
		const text = stripTerminalSequences(row).replace(/\u{10eeee}\p{M}*/gu, " ");
		const label = row.includes("\x1b_G") || row.includes("\x1b]1337;File=") ? "[Image]".slice(0, width) : "";
		bounded[index] = text.trim() ? text : label;
		excess -= Buffer.byteLength(row) - Buffer.byteLength(bounded[index]);
	}
	return bounded;
}

/** The alternate screen's image protocol and the Kitty images it has uploaded, from entering the screen to leaving it. */
export class AltScreenImages {
	protocol: ImageProtocol = null;
	readonly uploaded = new Map<number, CachedKittyImage>();
	private savedCapabilities?: TerminalCapabilities;

	/**
	 * Read the protocol on entering the screen. iTerm2 inline images do not scroll with the viewport, so they are
	 * turned off until `restore()`. Returns true when that changed the capabilities and components must re-render.
	 */
	start(): boolean {
		const capabilities = getCapabilities();
		this.protocol = capabilities.images;
		this.uploaded.clear();
		if (capabilities.images !== "iterm2") return false;
		this.savedCapabilities = capabilities;
		setCapabilities({ ...capabilities, images: null });
		return true;
	}

	/** Output that deletes every uploaded image under the current protocol; forgets the uploads. */
	deleteAll(): string {
		const deletion = deleteKittyImagesFor(this.protocol);
		this.uploaded.clear();
		return deletion;
	}

	/** The terminal's capabilities changed: delete the uploads under the old protocol, then read the new one. */
	refresh(): string {
		const deletion = this.deleteAll();
		this.protocol = getCapabilities().images;
		return deletion;
	}

	/** Give back the capabilities `start()` turned off. */
	restore(): void {
		if (!this.savedCapabilities) return;
		setCapabilities(this.savedCapabilities);
		this.savedCapabilities = undefined;
	}
}
