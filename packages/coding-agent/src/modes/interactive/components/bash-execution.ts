/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Spacer, Text, type TUI, truncateToVisualLines } from "@octocodeai/octocode-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { STATE_COLOR } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { hintText, keyHint, keyText } from "./keybinding-hints.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

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
	/** `dim` marks `!!` commands, whose output is excluded from the model context. */
	private readonly colorKey: "dim" | "bashMode";
	private outputPad: number;
	/** Output arrived since the last layout: rebuilt once per frame in render(), not once per streamed chunk. */
	private layoutStale = false;

	constructor(command: string, ui: TUI, excludeFromContext = false, outputPad = 1) {
		super();
		this.command = command;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		this.outputPad = outputPad;
		const borderColor = (str: string) => theme.fg(this.colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(STATE_COLOR.running, spinner),
			(text) => theme.fg("muted", text),
			`Running… · ${hintText([[keyText("tui.select.cancel"), "cancel"]])}`, // Plain text for loader
		);

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));

		this.updateDisplay();
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
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

	/** The executor strips colors from its stream, but an extension's result and a stored (possibly imported) session
	 * message arrive raw. Every control goes per piece, so a sequence split across chunks cannot rejoin. */
	private writeToCurrentLine(piece: string): void {
		const lastCarriageReturn = piece.lastIndexOf("\r");
		if (lastCarriageReturn !== -1) {
			this.currentLine = "";
			piece = piece.slice(lastCarriageReturn + 1);
		}
		this.currentLine = (this.currentLine + sanitizeTerminalText(piece)).slice(-DEFAULT_MAX_BYTES);
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

		// Stop loader
		this.loader.stop();

		this.updateDisplay();
	}

	/** Stops the running loader when the row leaves the transcript before the command finished. */
	dispose(): void {
		this.loader.stop();
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

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = this.droppedLines + availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command header
		const header = new Text(
			theme.fg(this.colorKey, theme.bold(`$ ${sanitizeTerminalText(this.command)}`)),
			this.outputPad,
			0,
		);
		this.contentContainer.addChild(header);
		if (this.header && this.status !== "running") {
			this.contentContainer.addChild(new Text(theme.fg("muted", sanitizeTerminalText(this.header)), this.outputPad, 0));
		}

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, this.outputPad, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, this.outputPad);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `… ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			// With a header, it already says how the command ended and where the full output is.
			if (!this.header && this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (!this.header && this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (!this.header && wasTruncated && this.fullOutputPath) {
				statusParts.push(
					theme.fg("warning", `Output truncated. Full output: ${sanitizeTerminalText(this.fullOutputPath)}`),
				);
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, this.outputPad, 0));
			}
		}
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
