import {
	animationClock,
	type Component,
	Loader,
	MOTION,
	SEPARATOR,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import type { WorkingIndicatorOptions } from "../../../core/features/index.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { formatDuration, formatTokens } from "../../../octocode/shared/format.ts";
import { liveShimmer } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { getRunClock } from "../../../utils/run-clock.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { hintText, keyText, rawKeyHint } from "../../../theme/theme-tui-helpers.ts";
import { styledLine } from "../../../../../common/src/sanitize.ts";

/** Longer details are thoughts or targets, not a verb: they stay plain. */
const SHIMMER_MAX_CHARS = 120;

/** The interrupt key as the hints show it: `esc`, not `escape`. */
function interruptKey(): string {
	return keyText("app.interrupt").replace(/^escape$/, "esc");
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
		return formatDuration(Date.now() - (getRunClock() ?? this.createdAt));
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
			(hint ? theme.fg("dim", SEPARATOR) + rawKeyHint(key, "interrupt") : "") +
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
		return liveShimmer(theme, plain);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s…${SEPARATOR}${hintText([[interruptKey(), "cancel"]])}`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("muted", spinner),
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

/** What a compaction's summary requests have done so far (`compaction_progress`). */
export interface CompactionProgress {
	elapsedMs: number;
	receivedChars: number;
}

/** `Compacting context… 1m05s · ~3.2k tokens received · esc cancel` (tokens estimated from characters); the time and size once the summary streams. */
function compactionMessage(label: string, progress?: CompactionProgress): string {
	const received =
		progress && progress.receivedChars > 0
			? `${SEPARATOR}~${formatTokens(Math.ceil(progress.receivedChars / CHARS_PER_TOKEN))} tokens received`
			: "";
	const shown = progress ? ` ${formatDuration(progress.elapsedMs)}${received}` : "";
	return `${label}${shown} · ${hintText([[interruptKey(), "cancel"]])}`;
}

export class CompactionStatusIndicator extends StatusIndicator {
	private readonly label: string;

	constructor(ui: TUI, reason: CompactionStatusReason, colorFn?: (text: string) => string) {
		const label =
			reason === "manual"
				? "Compacting context…"
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting…`;
		super(
			"compaction",
			ui,
			colorFn ?? ((spinner) => theme.fg("accent", spinner)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			compactionMessage(label),
		);
		this.label = label;
	}

	/** Shows how long the summary has been written and how much of it arrived; the session sends it at most once a second. */
	setProgress(progress: CompactionProgress): void {
		this.setMessage(compactionMessage(this.label, progress));
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch…${SEPARATOR}${hintText([[interruptKey(), "cancel"]])}`,
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
