import { type Component, type Terminal, TuiMainScreen, type TuiStopOptions } from "@octocodeai/octocode-tui";
import type { RenderOptions } from "ink";
import type { ReactNode } from "react";
import { type InkHost, type InkScreen, mountInk } from "./host.tsx";
import type { InputSource } from "./input.tsx";
import { RenderSignalSource } from "./render-signal.ts";

export interface InkTuiOptions {
	readonly screen: InkScreen;
	readonly showHardwareCursor?: boolean;
	readonly logDirectory?: string;
	readonly maxFps?: number;
	readonly incrementalRendering?: boolean;
	readonly onRender?: RenderOptions["onRender"];
	/** The React tree Ink shows; it reads the old component tree through `frame` and `signal`. */
	readonly app: (tui: InkTui) => ReactNode;
}

/**
 * The old renderer's component tree, focus, overlays and input routing, painted by Ink instead of the differential
 * writer. A paint request bumps `signal`; Ink paces the frames. Keys go through the terminal's parser to the
 * `InputContext` first, then to the focused legacy component.
 */
export class InkTui extends TuiMainScreen {
	readonly signal = new RenderSignalSource();
	/** The whole frame as rows: components, overlays and resolved cursors. */
	readonly frame: Component = { render: (width) => this.composeFrame(width), invalidate: () => this.invalidate() };
	readonly input: InputSource = {
		subscribe: (listener) => this.addInputListener((data) => (listener(data) ? { consume: true } : undefined)),
	};
	private host: InkHost | undefined;
	private readonly options: InkTuiOptions;

	constructor(terminal: Terminal, options: InkTuiOptions) {
		super(terminal, options.showHardwareCursor, options.logDirectory);
		this.options = options;
	}

	get inkHost(): InkHost | undefined {
		return this.host;
	}

	protected override doRender(): void {
		if (!this.stopped) this.signal.notify();
	}

	protected override afterTerminalStart(): void {
		this.host = mountInk(this.options.app(this), {
			terminal: this.terminal,
			screen: this.options.screen,
			input: this.input,
			maxFps: this.options.maxFps,
			incrementalRendering: this.options.incrementalRendering,
			onRender: this.options.onRender,
		});
	}

	protected override onTerminalResized(): void {
		this.host?.resized();
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.host?.unmount();
		this.host = undefined;
	}

	private composeFrame(width: number): string[] {
		const height = this.terminal.rows;
		let lines = [...this.render(width)];
		if (this.hasOverlayEntries) lines = this.compositeOverlays(lines, width, height);
		lines = this.resolveFakeCursors(lines);
		// The hardware cursor stays hidden while Ink paints: drop the markers that would place it.
		this.extractCursorPosition(lines, height);
		return this.applyLineResets(lines);
	}
}
