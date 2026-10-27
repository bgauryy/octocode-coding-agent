import { animationClock } from "../tokens/clock.ts";
import { MOTION, SPINNER } from "../tokens/design.ts";
import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES: readonly string[] = SPINNER.braille;
const DEFAULT_INTERVAL_MS: number = MOTION.spinnerMs;

/**
 * Loader component that updates with an optional spinning animation, driven by the shared animation clock: in reduced
 * motion it shows its first frame and does not animate.
 */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs: number = DEFAULT_INTERVAL_MS;
	private currentFrame = 0;
	private unsubscribe: (() => void) | undefined;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: (str: string) => string;
	private message: string = "Loading...";

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = 0;
		this.start();
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1) {
			return;
		}
		this.unsubscribe = animationClock.subscribe(
			() => {
				// Called once more when motion is reduced or resumed: repaint without advancing then.
				if (!animationClock.isReducedMotion()) this.currentFrame = (this.currentFrame + 1) % this.frames.length;
				this.updateDisplay();
			},
			{ everyMs: this.intervalMs, kind: "decor" },
		);
	}

	/**
	 * Whether the indicator animates; a static one (a single frame, or none, or reduced motion) never schedules a redraw
	 * of its own.
	 */
	protected isAnimated(): boolean {
		return this.frames.length > 1 && !animationClock.isReducedMotion();
	}

	protected getRenderedIndicator(): string {
		const frame = this.frames[animationClock.isReducedMotion() ? 0 : this.currentFrame] ?? "";
		return this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
	}

	private updateDisplay(): void {
		const renderedFrame = this.getRenderedIndicator();
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
