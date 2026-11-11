import { getCapabilities, setCapabilities } from "../terminal-image/capabilities.ts";
import type { ImageProtocol, TerminalCapabilities } from "../terminal-image/types.ts";
import { deleteKittyImagesFor } from "./kitty-cache.ts";
import type { CachedKittyImage } from "./types.ts";

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
