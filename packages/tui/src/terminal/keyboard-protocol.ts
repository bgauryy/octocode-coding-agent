import { setKittyProtocolActive } from "../keys/state.ts";
import { DEVICE_ATTRIBUTES_RESPONSE_PATTERN } from "./device-attributes.ts";

const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
/** Requests the desired Kitty flags, then queries the flags in effect. */
export const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u`;

type KeyboardProtocolNegotiationSequence = { type: "kitty-flags"; flags: number } | { type: "device-attributes" };

function parseKeyboardProtocolNegotiationSequence(sequence: string): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1], 10) };
	}
	if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export interface KeyboardProtocolHooks {
	/** Pass on input that turned out not to be a negotiation reply. */
	forward(sequence: string): void;
	/** The device attributes reply to the latest startup query arrived: no later reply is owed. */
	onLastDeviceAttributes(): void;
}

/**
 * Negotiates the keyboard protocol with the terminal: Kitty keyboard protocol when it answers the
 * flags query, modifyOtherKeys when the trailing device attributes reply comes first.
 *
 * Kitty's progressive enhancement detection requires requesting the desired flags before querying
 * them. The trailing DA query is a sentinel supported by terminals that do not know Kitty keyboard
 * protocol; receiving DA before a Kitty response enables the modifyOtherKeys fallback without a
 * startup timeout. The requested flags are:
 * - 1 = disambiguate escape codes
 * - 2 = report event types (press/repeat/release)
 * - 4 = report alternate keys (shifted key, base layout key)
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */
export class KeyboardProtocol {
	private readonly pendingResets = new Map<string, object>();

	private writeReset(sequence: string): void {
		const receipt = {};
		this.pendingResets.set(sequence, receipt);
		process.stdout.write(sequence, () => {
			if (this.pendingResets.get(sequence) === receipt) this.pendingResets.delete(sequence);
		});
	}

	/** Include mode resets queued by normal cleanup but not yet sent to the terminal. */
	restoreOnExit(write: (sequence: string) => void): void {
		const resets = new Set(this.pendingResets.keys());
		this.disable((sequence) => resets.add(sequence));
		for (const sequence of resets) write(sequence);
	}
	private readonly hooks: KeyboardProtocolHooks;
	private kittyActive = false;
	private modifyOtherKeysEnabled = false;
	private pushed = false;
	/** DA1 replies owed to keyboard protocol queries. Later DA1 replies answer other queries and are forwarded. */
	private pendingDeviceAttributes = 0;
	private negotiationBuffer = "";
	private bufferFlushTimer?: ReturnType<typeof setTimeout>;

	constructor(hooks: KeyboardProtocolHooks) {
		this.hooks = hooks;
	}

	get kittyProtocolActive(): boolean {
		return this.kittyActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this.modifyOtherKeysEnabled;
	}

	/** The startup queries are about to be sent; expect one device attributes reply for them. */
	beginNegotiation(): void {
		this.pushed = true;
		this.pendingDeviceAttributes += 1;
		this.clearBuffer();
	}

	/**
	 * Take one input sequence. Returns the sequence to forward as input, or undefined when it was
	 * a negotiation reply or may be the start of one split across reads.
	 */
	process(sequence: string): string | undefined {
		const negotiation = this.read(sequence);
		if (negotiation === "pending") {
			this.scheduleBufferFlush();
			return undefined; // Wait briefly for the rest of a split Kitty response.
		}
		if (negotiation && this.handle(negotiation.parsed)) {
			return undefined;
		}
		return negotiation?.sequence ?? sequence;
	}

	private handle(negotiationSequence: KeyboardProtocolNegotiationSequence): boolean {
		this.clearBuffer();
		if (negotiationSequence.type === "device-attributes") {
			if (this.pendingDeviceAttributes === 0) return false;
			this.pendingDeviceAttributes -= 1;
			// The last owed DA answers the latest query, which got no program status reply first. Earlier DA
			// replies belong to queries from before a restart.
			if (this.pendingDeviceAttributes === 0) this.hooks.onLastDeviceAttributes();
		}
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this.kittyActive) {
					this.kittyActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this.kittyActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	/** Returns the parsed negotiation reply with its full (possibly reassembled) sequence. */
	private read(
		sequence: string,
	): { parsed: KeyboardProtocolNegotiationSequence; sequence: string } | "pending" | undefined {
		if (this.negotiationBuffer) {
			const bufferedSequence = this.negotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearBuffer();
				return { parsed: negotiationSequence, sequence: bufferedSequence };
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setBuffer(bufferedSequence);
				return "pending";
			}
			this.flushBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return { parsed: negotiationSequence, sequence };
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setBuffer(sequence: string): void {
		this.clearBufferFlushTimer();
		this.negotiationBuffer = sequence;
	}

	private clearBuffer(): void {
		this.clearBufferFlushTimer();
		this.negotiationBuffer = "";
	}

	private flushBufferAsInput(): void {
		if (!this.negotiationBuffer) return;
		const sequence = this.negotiationBuffer;
		this.clearBuffer();
		this.hooks.forward(sequence);
	}

	private scheduleBufferFlush(): void {
		if (!this.negotiationBuffer || this.bufferFlushTimer) return;
		this.bufferFlushTimer = setTimeout(() => {
			this.bufferFlushTimer = undefined;
			this.flushBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearBufferFlushTimer(): void {
		if (!this.bufferFlushTimer) return;
		clearTimeout(this.bufferFlushTimer);
		this.bufferFlushTimer = undefined;
	}

	private enableModifyOtherKeys(): void {
		if (this.kittyActive || this.modifyOtherKeysEnabled) return;
		process.stdout.write("\x1b[>4;2m");
		this.modifyOtherKeysEnabled = true;
	}

	/** Drop pending protocol negotiation and turn off the Kitty keyboard protocol and modifyOtherKeys; safe to repeat. */
	disable(write: (sequence: string) => void = (sequence) => this.writeReset(sequence)): void {
		const shouldDisableKittyProtocol = this.pushed || this.kittyActive;
		this.clearBuffer();
		if (shouldDisableKittyProtocol) {
			write("\x1b[<u");
			this.pushed = false;
			this.kittyActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys(write);
	}

	private disableModifyOtherKeys(write: (sequence: string) => void = (sequence) => this.writeReset(sequence)): void {
		if (!this.modifyOtherKeysEnabled) return;
		write("\x1b[>4;0m");
		this.modifyOtherKeysEnabled = false;
	}
}
