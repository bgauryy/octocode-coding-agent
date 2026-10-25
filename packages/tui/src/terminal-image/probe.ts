import { allocateImageId } from "../terminal-image.ts";
import { setProbedImageProtocol, shouldProbeKittyGraphics } from "./capabilities.ts";

const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

/** Shares the keyboard query's DA1 sentinel, so missing graphics replies never delay startup. */
export class KittyGraphicsProbe {
	private imageId?: number;
	private answered = false;
	private onChange?: () => void;

	start(isTTY: boolean, onChange?: () => void): string {
		this.stop();
		if (!isTTY || !shouldProbeKittyGraphics()) return "";
		this.imageId = allocateImageId();
		this.onChange = onChange;
		// a=q validates PNG transmission without storing or displaying the pixel.
		return `\x1b_Gi=${this.imageId},a=q,t=d,f=100;${PIXEL_PNG}\x1b\\`;
	}

	consume(sequence: string): boolean {
		const reply = sequence.match(/^\x1b_G([^;]*);([^\x1b]*)\x1b\\$/);
		if (!reply) return false;
		const id = reply[1].match(/(?:^|,)i=(\d+)(?:,|$)/)?.[1];
		if (this.imageId !== undefined && Number(id) === this.imageId && !this.answered) {
			this.answered = true;
			if (setProbedImageProtocol(reply[2] === "OK" ? "kitty" : null)) this.onChange?.();
		}
		// Stale or unrelated graphics replies must not become editor input.
		return true;
	}

	finish(): void {
		if (this.imageId !== undefined && !this.answered && setProbedImageProtocol(null)) this.onChange?.();
		this.stop();
	}

	stop(): void {
		this.imageId = undefined;
		this.answered = false;
		this.onChange = undefined;
	}
}
