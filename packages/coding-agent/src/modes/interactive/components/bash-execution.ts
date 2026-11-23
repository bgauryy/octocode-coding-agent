/**
 * The row of a user `!` command, in the tool-row grammar: `✓ ! cmd · you · 4.2s`, then `  ⎿  exit 0 · 4 lines` and the
 * output hanging under the gutter. No frame: the mark and the outcome words carry the state.
 */

import {
	animationClock,
	Container,
	GLYPH,
	linkPath,
	Loader,
	MOTION,
	MouseRegion,
	renderChanged,
	Spacer,
	Text,
	trackRenderChanges,
	type TUI,
} from "@octocodeai/octocode-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { styleShellLines } from "../../../theme/output-style.ts";
import { STATE_COLOR, stateMark, type UiState } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { OutputPreview, outcomeParts } from "./bash-execution-parts.ts";
import { hintText, interruptKey } from "../../../theme/theme-tui-helpers.ts";
import { STOPPED_COLOR } from "../../../octocode/render/types.ts";
import { expandHint } from "../../../octocode/shared/text.ts";
import { formatDuration } from "../../../utils/duration.ts";

// Last lines of a user `!` command shown while collapsed: more than an agent's tool row, since the user asked for this
// output and reads it directly.
const PREVIEW_LINES = 20;
/** The `⎿` gutter that leads the outcome row; the output hangs under it at the same width. */
const GUTTER = `  ${GLYPH.gutter}  `;
const HANG = " ".repeat(GUTTER.length);

export class BashExecutionComponent extends Container {
	private command: string;
	/** Finished lines of the newest output; the line still being written is `currentLine`. Bounded, see trimTail(). */
	private tailLines: string[] = [];
	private currentLine = "";
	private retainedChars = 0;
	/** Lines dropped from the front of the tail. */
	private droppedLines = 0;
	/** The last chunk ended with a CR: a following LF makes it a line break, anything else makes it a redraw. */
	private pendingCarriageReturn = false;
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	/** The result's first line (`[exit 0 · 4.2s · 312 lines · 18 KB]`), shown like the bash tool row's. */
	private header?: string;
	private expanded = false;
	private contentContainer: Container;
	/** `dim` marks `!!` commands, whose output is excluded from the model context; both are neutral, not a state colour. */
	private readonly colorKey: "dim" | "bashMode";
	private readonly excludeFromContext: boolean;
	private readonly ui: Pick<TUI, "keepScrollbackOnCollapse">;
	private outputPad: number;
	/** Whether the output has lines the preview hides (or is open): only then does a click toggle it. */
	private expandable = false;
	/** Output arrived since the last layout: rebuilt once per frame in render(), not once per streamed chunk. */
	private layoutStale = false;
	private readonly startedAt = Date.now();
	/** The 1 s tick that keeps the running time current; gone once the command ends or the row leaves. */
	private stopClock: (() => void) | undefined;

	constructor(command: string, ui: TUI, excludeFromContext = false, outputPad = 1) {
		super();
		this.ui = ui;
		this.command = command;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		this.excludeFromContext = excludeFromContext;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		this.addChild(
			new MouseRegion(this.contentContainer, (event) => {
				if (event.type !== "click" || event.button !== "left" || !this.expandable) return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(STATE_COLOR.running, spinner),
			(text) => theme.fg("muted", text),
			this.runningMessage(),
		);
		let shown = this.runningMessage();
		this.stopClock = animationClock.subscribe(
			() => {
				const next = this.runningMessage();
				if (next === shown) return;
				shown = next;
				this.loader.setMessage(next);
			},
			{ everyMs: MOTION.tickMs, kind: "info" },
		);

		this.updateDisplay();
	}

	/** `Running… 12s · esc cancel`: the time from 1s on, as the title shows it once the command ends. */
	private runningMessage(): string {
		const elapsed = Date.now() - this.startedAt;
		return `Running…${elapsed >= 1000 ? ` ${formatDuration(elapsed)}` : ""} · ${hintText([[interruptKey(), "cancel"]])}`;
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		// Output that scrolled away stays in scrollback when it collapses; only the screen is repainted.
		if (this.expanded && !expanded) this.ui.keepScrollbackOnCollapse?.();
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.layoutStale) this.updateDisplay();
		return super.render(width);
	}

	/**
	 * Add streamed output. A carriage return redraws the current line, as a terminal draws it (progress bars):
	 * only the text after the last one stays. CR LF is one line break. Only a bounded tail is kept; the command's
	 * final output replaces it through replaceOutput().
	 */
	appendOutput(chunk: string): void {
		let text = this.pendingCarriageReturn ? `\r${chunk}` : chunk;
		this.pendingCarriageReturn = text.endsWith("\r");
		if (this.pendingCarriageReturn) text = text.slice(0, -1);

		let start = 0;
		while (true) {
			const lineEnd = text.indexOf("\n", start);
			if (lineEnd === -1) {
				this.writeToCurrentLine(text.slice(start));
				break;
			}
			const endsWithCrLf = lineEnd > start && text[lineEnd - 1] === "\r";
			this.writeToCurrentLine(text.slice(start, endsWithCrLf ? lineEnd - 1 : lineEnd));
			this.tailLines.push(this.currentLine);
			this.retainedChars += this.currentLine.length + 1;
			this.currentLine = "";
			start = lineEnd + 1;
		}
		this.trimTail();
		this.layoutStale = true;
		renderChanged(this);
	}

	/** Show `output` as the whole output, in place of the streamed tail. */
	replaceOutput(output: string): void {
		this.tailLines = [];
		this.currentLine = "";
		this.retainedChars = 0;
		this.droppedLines = 0;
		this.pendingCarriageReturn = false;
		this.appendOutput(output);
	}

	/** The executor strips colors from its stream, but a feature's result and a stored (possibly imported) session
	 * message arrive raw. Every control goes per piece, so a sequence split across chunks cannot rejoin. */
	private writeToCurrentLine(piece: string): void {
		const lastCarriageReturn = piece.lastIndexOf("\r");
		if (lastCarriageReturn !== -1) this.currentLine = "";
		const visible = lastCarriageReturn !== -1 ? piece.slice(lastCarriageReturn + 1) : piece;
		this.currentLine = (this.currentLine + sanitizeTerminalText(visible)).slice(-DEFAULT_MAX_BYTES);
	}

	/** Drop the oldest lines beyond what the view can show (the same limits as the bash tool, twice the bytes). */
	private trimTail(): void {
		let drop = Math.max(0, this.tailLines.length - DEFAULT_MAX_LINES);
		let droppedChars = 0;
		for (let i = 0; i < drop; i++) droppedChars += this.tailLines[i].length + 1;
		while (this.retainedChars - droppedChars > 2 * DEFAULT_MAX_BYTES && drop < this.tailLines.length) {
			droppedChars += this.tailLines[drop].length + 1;
			drop++;
		}
		if (drop === 0) return;
		this.tailLines.splice(0, drop);
		this.retainedChars -= droppedChars;
		this.droppedLines += drop;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
		header?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		this.header = header;

		this.stopRunning();

		this.updateDisplay();
	}

	/** Stops the running loader when the row leaves the transcript before the command finished. */
	dispose(): void {
		this.stopRunning();
	}

	private stopRunning(): void {
		this.loader.stop();
		this.stopClock?.();
		this.stopClock = undefined;
	}

	/** The state of a finished command (undefined while it runs): the one source of its mark and outcome colour. */
	private finishedState(): UiState | undefined {
		switch (this.status) {
			case "running":
				return undefined;
			case "complete":
				return "done";
			case "error":
				return "failed";
			case "cancelled":
				return "stopped";
		}
	}

	private updateDisplay(): void {
		this.layoutStale = false;
		// Apply truncation for LLM context limits (same limits as bash tool)
		const fullOutput = this.getOutput();
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
		// Output that ends with a newline has no last line to draw.
		while (availableLines.at(-1) === "") availableLines.pop();

		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = this.droppedLines + availableLines.length - previewLogicalLines.length;

		this.contentContainer.clear();
		this.expandable = this.expanded || hiddenLineCount > 0;

		const state = this.finishedState();
		const pad = this.outputPad;
		const ended = this.header ? outcomeParts(sanitizeTerminalText(this.header)) : undefined;
		// `<mark> ! cmd · you · 4.2s`: the mark carries the outcome; the time shows here once, from 1s on.
		const mark = state ? `${stateMark(theme, state)} ` : "";
		const prompt = `${this.excludeFromContext ? "!!" : "!"} ${sanitizeTerminalText(this.command)}`;
		const meta = theme.fg("dim", [" · you", ended?.time ? ` · ${ended.time}` : ""].join(""));
		this.contentContainer.addChild(new Text(mark + theme.fg(this.colorKey, theme.bold(prompt)) + meta, pad, 0));

		// The outcome in words under the gutter: the result header's, else the exit code or the interruption.
		if (state) {
			const words =
				ended?.text ??
				(state === "stopped"
					? "interrupted"
					: this.exitCode === undefined || this.exitCode === null
						? "done"
						: `exit ${this.exitCode}`);
			const color = state === "failed" ? "error" : state === "stopped" ? STOPPED_COLOR : "muted";
			const linked = ended?.path ? words.replace(ended.path, linkPath(ended.path, ended.path)) : words;
			this.contentContainer.addChild(new Text(theme.fg("dim", GUTTER) + theme.fg(color, linked), pad, 0));
		}

		// Collapsed, the count of hidden lines leads the tail, as on a tool row.
		if (!this.expanded && hiddenLineCount > 0 && this.status !== "running") {
			const earlier = `… +${hiddenLineCount} earlier ${hiddenLineCount === 1 ? "line" : "lines"}`;
			this.contentContainer.addChild(
				new Text(theme.fg("dim", [earlier, expandHint()].filter(Boolean).join(" ")), pad + HANG.length, 0),
			);
		}

		// A failure's output is what the reader came for: text colour, not the muted of a quiet success.
		const outputColor = state === "failed" ? "text" : "muted";
		if (availableLines.length > 0) {
			if (this.expanded) {
				const displayText = styleShellLines(theme, availableLines, outputColor).join("\n");
				this.contentContainer.addChild(new Text(displayText, pad + HANG.length, 0));
			} else {
				const styledOutput = styleShellLines(theme, previewLogicalLines, outputColor).join("\n");
				this.contentContainer.addChild(new OutputPreview(styledOutput, PREVIEW_LINES, pad + HANG.length));
			}
		}

		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
			return;
		}
		const notes: string[] = [];
		if (this.expanded && hiddenLineCount > 0) {
			const hint = expandHint("collapse");
			if (hint) notes.push(theme.fg("dim", hint));
		}
		// Without a result header nothing above names the full output, so a truncated one says where it is.
		const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
		if (!this.header && wasTruncated && this.fullOutputPath) {
			const path = sanitizeTerminalText(this.fullOutputPath);
			notes.push(theme.fg("warning", `Output truncated. Full output: ${linkPath(path, path)}`));
		}
		if (notes.length > 0) this.contentContainer.addChild(new Text(notes.join("\n"), pad + HANG.length, 0));
	}

	/** The retained output: all of it for a normal command, the newest part of a very long stream. */
	getOutput(): string {
		return [...this.tailLines, this.currentLine].join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
trackRenderChanges(BashExecutionComponent.prototype);
