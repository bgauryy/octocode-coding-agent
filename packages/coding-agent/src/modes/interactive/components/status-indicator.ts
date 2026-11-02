import {
	animationClock,
	type Component,
	Loader,
	MOTION,
	mixColors,
	shimmerText,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import type { WorkingIndicatorOptions } from "../../../core/features/index.ts";
import { formatDuration } from "../../../octocode/shared/format.ts";
import { theme } from "../../../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";
import { styledLine } from "./styled-line.ts";

/** Longer details are thoughts or targets, not a verb: they stay plain. */
const SHIMMER_MAX_CHARS = 120;

/** The interrupt key as the hints show it: `esc`, not `escape`. */
function interruptKey(): string {
	return keyText("app.interrupt").replace(/^escape$/, "esc");
}

/** When the current run began, so a working line created mid-run (after a retry or a compaction) keeps the run's clock. */
let runStartedAt: number | undefined;

/** Start (`at`) or end (`undefined`) the run clock the working line counts from. */
export function setRunClock(at: number | undefined): void {
	runStartedAt = at;
}

/** Room the detail keeps before the time and hint are given up one by one. */
const MIN_DETAIL_COLUMNS = 12;

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	private workingMessage: string;
	private readonly createdAt = Date.now();
	/** Repaints once a second while the spinner is still, so the run clock advances (an animated spinner repaints anyway). */
	private unsubscribeClock: (() => void) | undefined;

	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, colorFn?: (text: string) => string) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
		this.workingMessage = message;
		this.unsubscribeClock = animationClock.subscribe(
			() => {
				if (!this.isAnimated()) ui.requestRender();
			},
			{ everyMs: MOTION.tickMs, kind: "info" },
		);
	}

	override setMessage(message: string): void {
		this.workingMessage = message;
		super.setMessage(message);
	}

	override dispose(): void {
		this.unsubscribeClock?.();
		this.unsubscribeClock = undefined;
		super.dispose();
	}

	/** The whole run's elapsed time, in the one duration format. */
	private elapsed(): string {
		return formatDuration(Date.now() - (runStartedAt ?? this.createdAt));
	}

	/**
	 * `<spinner> <detail> (12s · esc to interrupt)`. The clock sits right after the detail, so a narrow terminal clips the
	 * detail, never the time; the interrupt hint goes first when even that does not fit.
	 */
	private compose(width: number, paint: (detail: string) => string, withHint: boolean): string {
		// Model thinking and tool targets reach this line, so only colours survive.
		const detail = styledLine(this.workingMessage);
		const prefix = ` ${this.getRenderedIndicator()} `;
		const key = withHint ? interruptKey() : "";
		const paintedSuffix = (hint: boolean) =>
			theme.fg("dim", ` (${this.elapsed()}`) +
			(hint ? theme.fg("dim", " · ") + theme.fg("muted", key) + theme.fg("dim", " to interrupt") : "") +
			theme.fg("dim", ")");
		let suffix = paintedSuffix(Boolean(key));
		if (key && width - visibleWidth(prefix) - visibleWidth(suffix) < MIN_DETAIL_COLUMNS) suffix = paintedSuffix(false);
		const room = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const shown = visibleWidth(detail) <= room ? paint(detail) : paint(truncateToWidth(detail, room, "…"));
		return truncateToWidth(`${prefix}${shown}${suffix}`, Math.max(0, width), "…");
	}

	override render(width: number): string[] {
		return ["", this.compose(width, (detail) => this.paintDetail(detail), true)];
	}

	override renderInBorder(width: number): string {
		const line = this.compose(width + 1, (detail) => theme.fg("muted", detail), false);
		return truncateToWidth(line.slice(1).trimEnd(), width, "");
	}

	/**
	 * The detail (what the agent is doing now) with a light band sweeping across it while the indicator animates. The
	 * loader's frame timer drives the redraws; a static indicator, or a theme without concrete colors, draws it plain.
	 */
	private paintDetail(detail: string): string {
		const plain = stripTerminalSequences(detail);
		if (!this.isAnimated() || plain !== detail || plain.length > SHIMMER_MAX_CHARS) return theme.fg("text", detail);
		try {
			const colors = theme.colors;
			const base = colors.text;
			const accent = colors.accent;
			if (!base || !accent) return theme.fg("text", detail);
			const peak = mixColors(base, accent, theme.appearance === "light" ? 0.7 : 0.55);
			return shimmerText(plain, { base, peak, mode: theme.getColorMode() });
		} catch {
			return theme.fg("text", detail);
		}
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s… (${interruptKey()} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason, colorFn?: (text: string) => string) {
		const cancelHint = `(${interruptKey()} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context… ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting… ${cancelHint}`;
		super(
			"compaction",
			ui,
			colorFn ?? ((spinner) => theme.fg("accent", spinner)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch… (${interruptKey()} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
