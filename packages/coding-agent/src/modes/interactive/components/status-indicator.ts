import {
	type Component,
	Loader,
	mixColors,
	shimmerText,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

/** Longer details are thoughts or targets, not a verb: they stay plain. */
const SHIMMER_MAX_CHARS = 120;

/** The interrupt key as the hints show it: `esc`, not `escape`. */
function interruptKey(): string {
	return keyText("app.interrupt").replace(/^escape$/, "esc");
}

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
	}

	override setMessage(message: string): void {
		this.workingMessage = message;
		super.setMessage(message);
	}

	override render(width: number): string[] {
		const detail = this.workingMessage.replace(/[\r\n]+/g, " ");
		let line = ` ${this.getRenderedIndicator()} ${this.paintDetail(detail)}`;
		const key = interruptKey();
		const hint = key ? `${theme.fg("muted", key)}${theme.fg("dim", " to interrupt")}` : "";
		const gap = width - visibleWidth(line) - visibleWidth(hint) - 1;
		if (hint && gap >= 4) line += `${" ".repeat(gap)}${hint}`;
		return ["", truncateToWidth(line, Math.max(0, width), "…")];
	}

	/**
	 * The detail (what the agent is doing now) with a light band sweeping across it while the indicator animates. The
	 * loader's frame timer drives the redraws; a static indicator, or a theme without concrete colors, draws it plain.
	 */
	private paintDetail(detail: string): string {
		const plain = detail.replace(/\x1b\[[0-9;]*m/g, "");
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
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
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
