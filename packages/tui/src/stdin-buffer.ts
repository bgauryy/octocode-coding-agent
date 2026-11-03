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

const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
/**
 * A bracketed paste whose end marker has not arrived after this long without input is emitted as is, so a lost
 * marker cannot capture all later typing. Terminals send a paste in quick chunks, even over SSH.
 */
export const PASTE_IDLE_TIMEOUT_MS = 1000;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

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
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	/** True between a bracketed paste's start marker and its end marker. */
	get pasting(): boolean {
		return this.pasteMode;
	}

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
		this.pasteTimeoutMs = options.pasteTimeout ?? PASTE_IDLE_TIMEOUT_MS;
	}

	public process(data: string | Buffer): void {
		// Clear any pending timeout
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

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";
			this.continuePaste();
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				// The paste marker ends whatever came before it, so an incomplete tail (a lone Escape) is emitted as is.
				const result = extractCompleteSequences(this.buffer.slice(0, startIndex));
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
				if (result.remainder) this.emitDataSequence(result.remainder);
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.pasteMode = true;
			this.pasteBuffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.buffer = "";
			this.continuePaste();
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			// Only a recognizable reply header establishes a delimited string.
			// Flushing it would turn a delayed tail into text and an OSC's BEL
			// terminator into Ctrl+G (the external editor shortcut). Other input,
			// including Alt+] followed by text, must retain bounded recovery.
			if (TERMINAL_REPLY_HEADER_PATTERN.test(this.buffer)) return;
			const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

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

	/** Emit the paste once its end marker arrived, then process what followed; otherwise wait for more of it. */
	private continuePaste(): void {
		const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) {
			this.timeout = setTimeout(() => this.endPaste(this.pasteBuffer, ""), this.pasteTimeoutMs);
			return;
		}
		this.endPaste(this.pasteBuffer.slice(0, endIndex), this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length));
	}

	private endPaste(content: string, remaining: string): void {
		this.timeout = null;
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", content);
		if (remaining.length > 0) this.process(remaining);
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
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
