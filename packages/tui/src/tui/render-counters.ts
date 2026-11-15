/** What the renderer did, for tests and diagnostics: requests are intent, frames and replays are cost. */
export interface RenderCounters {
	/** `requestRender` calls: components asking for a frame, with or without a change. */
	requested: number;
	/** Frames the render loop painted (requests of one tick coalesce into one). */
	painted: number;
	/** Painted frames that wrote rows to the terminal; the rest found nothing visible to change. */
	written: number;
	/** Frames that cleared the screen and scrollback and wrote the whole transcript again. */
	fullRedraws: number;
	/** Frames where rows above the viewport changed (in place, or a collapse) and were left alone, since scrollback cannot be edited. */
	deferredAboveViewport: number;
}

/** The renderer's counters and the one-shot request to replay scrollback. */
export class RenderLedger {
	readonly counters = { requested: 0, painted: 0, written: 0, deferredAboveViewport: 0 };
	private repaint = false;

	/** The next frame replays the whole transcript if any row above the viewport changed. */
	askRepaint(): void {
		this.repaint = true;
	}

	/** Whether a replay was asked for since the last frame; reading it spends the request. */
	takeRepaint(): boolean {
		const asked = this.repaint;
		this.repaint = false;
		return asked;
	}

	/** Run one painted frame. */
	frame<T>(paint: () => T): T {
		this.counters.painted += 1;
		return paint();
	}

	snapshot(fullRedraws: number): Readonly<RenderCounters> {
		return { ...this.counters, fullRedraws };
	}
}
