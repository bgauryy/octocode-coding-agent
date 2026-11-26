/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "node:events";

import {
	ESC,
	extractCompleteSequences,
	isControlString,
	parseUnmodifiedKittyPrintableCodepoint,
	TERMINAL_REPLY_HEADER_PATTERN,
} from "./stdin-buffer/sequences.ts";
import { DroppedMouseReport, MOUSE_TAIL_WINDOW_MS } from "./stdin-buffer/dropped-mouse.ts";
import { isTypedCodePoint } from "./stdin-buffer/typed-run.ts";

const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const PARTIAL_MOUSE_REPORT_PATTERN = /^\x1b\[<[\d;]*$/;
const ORPHAN_MOUSE_REPORT_PATTERN = /^\[<\d+;\d+;\d+[Mm]/;
const ORPHAN_MOUSE_PREFIX_PATTERN = /^\[(?:<(?:\d+(?:;(?:\d+(?:;\d*)?)?)?)?)?$/;
/**
 * A bracketed paste whose end marker has not arrived after this long without input is emitted as is, so a lost
 * marker cannot capture all later typing. Terminals send a paste in quick chunks, even over SSH.
 */
export const PASTE_IDLE_TIMEOUT_MS = 1000;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
/**
 * A strict prefix of the paste start marker (`\x1b[2`, `\x1b[20`, `\x1b[200`), cut off where a read split it. It waits as
 * long as a paste does: flushed at the key timeout, the pasted text that follows would be typed, and its newlines submit.
 */
const isPasteStartPrefix = (text: string): boolean =>
	text.length >= 3 && text.length < BRACKETED_PASTE_START.length && BRACKETED_PASTE_START.startsWith(text);
/** The start of a Kitty flags or device attributes reply, as the keyboard protocol parser buffers it. */
const REPLY_PREFIX = /^\x1b\[(?:\?[\d;]*)?$/;

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for an incomplete keyboard or mouse sequence
	 * (default: 50ms). Strings with a recognized terminal reply header wait for
	 * their terminator instead, so delayed replies cannot become keypresses.
	 * Ambiguous legacy Alt-key input still uses this timeout.
	 */
	timeout?: number;
	/**
	 * Maximum time to wait after a lone ESC before treating it as Escape
	 * (default: 10ms). Increase for high-latency Alt+key input (SSH).
	 */
	escapeTimeout?: number;
	/**
	 * Time without input after which a bracketed paste whose end marker never arrived is emitted
	 * (default: PASTE_IDLE_TIMEOUT_MS). Increase for very slow links.
	 */
	pasteTimeout?: number;
	/** Emit consecutive typed characters as one sequence (default: true); false emits one code point at a time. */
	typedRuns?: boolean;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly escapeTimeoutMs: number;
	private readonly pasteTimeoutMs: number;
	private readonly typedRuns: boolean;
	private pasteMode: boolean = false;
	private pasteChunks: string[] = [];
	private pasteTail = "";
	private pendingKittyPrintableCodepoint: number | undefined;
	/** The start of a keyboard protocol reply emitted so far (`\x1b[?62`), while the next input may continue it. */
	private replyPrefix: string | undefined;

	/** True between a bracketed paste's start marker and its end marker. */
	get pasting(): boolean {
		return this.pasteMode;
	}

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
		this.pasteTimeoutMs = options.pasteTimeout ?? PASTE_IDLE_TIMEOUT_MS;
		this.typedRuns = options.typedRuns ?? true;
		this.droppedMouse = new DroppedMouseReport(this.timeoutMs, (held) => this.process(held));
	}

	private afterLoneEscape = false;
	private loneEscapeAt = 0;
	/** What the flush already emitted after the ESC: "" for a lone ESC, "[" for ESC [ (also Alt+[). */
	private orphanLead = "";
	private readonly droppedMouse: DroppedMouseReport;
	private orphanMouse: string | undefined;
	private orphanTimeout: ReturnType<typeof setTimeout> | null = null;

	public process(data: string | Buffer): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0] > 127) {
				const byte = data[0] - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		if (this.afterLoneEscape && Date.now() - this.loneEscapeAt > MOUSE_TAIL_WINDOW_MS) this.afterLoneEscape = false;
		str = this.droppedMouse.expire(Date.now()) + str;
		if (this.orphanMouse !== undefined || this.afterLoneEscape || this.droppedMouse.active) {
			str = this.filterOrphanMouse(str);
			if (str.length === 0) return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			const chunk = this.buffer;
			this.buffer = "";
			this.continuePaste(chunk);
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				// The paste marker ends whatever came before it, so an incomplete tail (a lone Escape) is emitted as is.
				const result = extractCompleteSequences(this.buffer.slice(0, startIndex));
				this.emitSequences(result.sequences);
				if (result.remainder) this.emitDataSequence(result.remainder);
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.pasteMode = true;
			const chunk = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.buffer = "";
			this.continuePaste(chunk);
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;
		this.emitSequences(result.sequences);

		if (this.buffer.length > 0) {
			// Only a recognizable reply header establishes a delimited string.
			// Flushing it would turn a delayed tail into text and an OSC's BEL
			// terminator into Ctrl+G (the external editor shortcut). Other input,
			// including Alt+] followed by text, must retain bounded recovery.
			if (TERMINAL_REPLY_HEADER_PATTERN.test(this.buffer)) return;
			if (PARTIAL_MOUSE_REPORT_PATTERN.test(this.buffer)) {
				// A cut SGR mouse report is not text: drop it if its tail never arrives.
				this.timeout = setTimeout(() => {
					this.timeout = null;
					this.droppedMouse.begin(this.buffer, Date.now());
					this.buffer = "";
				}, this.timeoutMs);
				return;
			}
			const timeoutMs =
				this.buffer === ESC
					? this.escapeTimeoutMs
					: isPasteStartPrefix(this.buffer)
						? this.pasteTimeoutMs
						: this.timeoutMs;
			this.timeout = setTimeout(() => {
				const flushed = this.flush();
				this.afterLoneEscape = flushed.length === 1 && (flushed[0] === ESC || flushed[0] === `${ESC}[`);
				this.orphanLead = flushed[0]?.slice(ESC.length) ?? "";
				this.loneEscapeAt = Date.now();

				for (const sequence of flushed) {
					if (sequence.length > 2 && isControlString(sequence)) {
						// Recover the Alt key and reparse its tail so batched text,
						// Enter, and control keys are not swallowed as one event.
						this.emitDataSequence(sequence.slice(0, 2));
						this.process(sequence.slice(2));
					} else {
						this.emitDataSequence(sequence);
					}
				}
			}, timeoutMs);
		}
	}

	/**
	 * A mouse report whose ESC was flushed alone arrives as `[<b;x;yM`. Drop it, including when it is cut again,
	 * so it never becomes typed text. Held text that turns out not to be a report is released unchanged.
	 */
	private filterOrphanMouse(str: string): string {
		if (this.droppedMouse.active) {
			// The head of a report was dropped on timeout: a chunk that completes it is its tail, not text.
			const fed = this.droppedMouse.feed(str);
			if (fed.kind === "consumed") return fed.rest;
			if (fed.kind === "held") return "";
			str = fed.text;
		}
		const pending = (this.orphanMouse ?? "") + str;
		this.orphanMouse = undefined;
		if (this.orphanTimeout) clearTimeout(this.orphanTimeout);
		this.orphanTimeout = null;
		this.afterLoneEscape = false;
		// The flush already emitted the lead (`[` after `ESC [`); match the report with it, drop only what follows.
		const lead = this.orphanLead;
		this.orphanLead = "";
		const probe = lead + pending;
		const complete = ORPHAN_MOUSE_REPORT_PATTERN.exec(probe);
		if (complete) return pending.slice(complete[0].length - lead.length);
		if (ORPHAN_MOUSE_PREFIX_PATTERN.test(probe)) {
			this.orphanLead = lead;
			this.orphanMouse = pending;
			this.orphanTimeout = setTimeout(() => {
				const held = this.orphanMouse;
				this.orphanMouse = undefined;
				this.orphanLead = "";
				this.orphanTimeout = null;
				if (held) this.process(held);
			}, this.timeoutMs);
			return "";
		}
		return pending;
	}

	/** Emit the paste once its end marker arrived, then process what followed; otherwise wait for more of it. */
	private continuePaste(chunk: string): void {
		// Search only new input plus the possible split marker, never flatten and rescan the entire paste per chunk.
		const pending = this.pasteTail + chunk;
		const endIndex = pending.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) {
			const safeEnd = Math.max(0, pending.length - BRACKETED_PASTE_END.length + 1);
			if (safeEnd > 0) this.pasteChunks.push(pending.slice(0, safeEnd));
			this.pasteTail = pending.slice(safeEnd);
			this.timeout = setTimeout(() => this.endPaste(this.pasteTail, ""), this.pasteTimeoutMs);
			return;
		}
		this.endPaste(pending.slice(0, endIndex), pending.slice(endIndex + BRACKETED_PASTE_END.length));
	}

	private endPaste(content: string, remaining: string): void {
		this.pasteChunks.push(content);
		const pasted = this.pasteChunks.join("");
		this.timeout = null;
		this.pasteMode = false;
		this.pasteChunks = [];
		this.pasteTail = "";
		this.pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", pasted);
		if (remaining.length > 0) this.process(remaining);
	}

	/**
	 * Emit `sequences` in order. Consecutive typed characters (`isTypedCodePoint`) go out as one sequence, which the
	 * TUI routes key by key and hands to a component that takes a typed run at once. After a partial terminal reply
	 * (`\x1b[?6` cut by the sequence timeout) characters stay single, as the reply parser downstream joins them one at a time.
	 */
	private emitSequences(sequences: readonly string[]): void {
		let run = "";
		const flush = () => {
			if (run) this.emit("data", run);
			run = "";
		};
		for (const sequence of sequences) {
			const code = sequence.codePointAt(0);
			const typed =
				code !== undefined && String.fromCodePoint(code).length === sequence.length && isTypedCodePoint(code);
			if (!typed || !this.typedRuns || this.replyPrefix !== undefined) {
				flush();
				this.emitDataSequence(sequence);
			} else if (code === this.pendingKittyPrintableCodepoint) {
				// The raw copy of a key the terminal already sent as a Kitty sequence (see emitDataSequence).
				this.pendingKittyPrintableCodepoint = undefined;
			} else {
				this.pendingKittyPrintableCodepoint = undefined;
				run += sequence;
			}
		}
		flush();
	}

	private emitDataSequence(sequence: string): void {
		const firstCodepoint = sequence.codePointAt(0);
		const rawCodepoint =
			firstCodepoint !== undefined && String.fromCodePoint(firstCodepoint).length === sequence.length
				? firstCodepoint
				: undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		// Follows the keyboard protocol parser's buffer: a reply prefix grows while it stays one, else restarts.
		if (this.replyPrefix !== undefined && REPLY_PREFIX.test(this.replyPrefix + sequence)) this.replyPrefix += sequence;
		else this.replyPrefix = REPLY_PREFIX.test(sequence) ? sequence : undefined;
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteChunks = [];
		this.pasteTail = "";
		this.pendingKittyPrintableCodepoint = undefined;
		this.replyPrefix = undefined;
		if (this.orphanTimeout) clearTimeout(this.orphanTimeout);
		this.orphanTimeout = null;
		this.orphanMouse = undefined;
		this.orphanLead = "";
		this.afterLoneEscape = false;
		this.droppedMouse.clear();
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
