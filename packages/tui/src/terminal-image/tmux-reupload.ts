import { tmuxPaneClients } from "../multiplexer.ts";

const ENVELOPE_START = "\x1bPtmux;";
/** A passthrough envelope that carries Kitty graphics (its payload's ESC is doubled). */
const KITTY_ENVELOPE_START = `${ENVELOPE_START}\x1b\x1b_G`;

/** End index of the passthrough envelope starting at `start`, or -1 when it is not terminated. */
function envelopeEnd(line: string, start: number): number {
	let index = start + ENVELOPE_START.length;
	for (;;) {
		const esc = line.indexOf("\x1b", index);
		if (esc < 0) return -1;
		const next = line[esc + 1];
		if (next === "\\") return esc + 2;
		if (next !== "\x1b") return -1;
		index = esc + 2;
	}
}

/** The tmux-wrapped Kitty uploads that rendered lines carry, concatenated in order. */
export function kittyPassthroughUploads(lines: readonly string[]): string {
	let out = "";
	for (const line of lines) {
		let start = line.indexOf(KITTY_ENVELOPE_START);
		while (start >= 0) {
			const end = envelopeEnd(line, start);
			if (end < 0) break;
			out += line.slice(start, end);
			start = line.indexOf(KITTY_ENVELOPE_START, end);
		}
	}
	return out;
}

export type TmuxClientQuery = () => Promise<readonly string[] | undefined>;

/**
 * tmux stores placeholder cells and redraws them for a client that attaches later, but that client never received the
 * Kitty uploads behind them, so the images stay blank. With `focus-events on`, tmux sends the pane a focus-in on attach
 * (and on every pane or window switch). On a focus-in, when tmux lists a client not seen at the previous check, or cannot
 * list clients, the uploads of the rendered lines are sent again; a pane switch with the same clients sends nothing.
 */
export class TmuxImageReupload {
	private known: ReadonlySet<string> | undefined;
	private checking = false;
	private readonly queryClients: TmuxClientQuery;

	constructor(queryClients: TmuxClientQuery = () => tmuxPaneClients()) {
		this.queryClients = queryClients;
	}

	async focusIn(lines: () => readonly string[], write: (data: string) => void): Promise<void> {
		if (this.checking) return;
		this.checking = true;
		try {
			const clients = await this.queryClients();
			const known = this.known;
			this.known = clients ? new Set(clients) : undefined;
			if (clients && known && clients.every((client) => known.has(client))) return;
			const uploads = kittyPassthroughUploads(lines());
			if (uploads) write(uploads);
		} finally {
			this.checking = false;
		}
	}
}
