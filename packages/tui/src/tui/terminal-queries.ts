import { DEVICE_ATTRIBUTES_QUERY, DEVICE_ATTRIBUTES_RESPONSE_PATTERN } from "../terminal/device-attributes.ts";
import type { Terminal } from "../terminal/types.ts";
import { FENCE_REPLY } from "./latency-fence.ts";
import {
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "../terminal-colors.ts";
import { getCapabilities, setCellDimensions } from "../terminal-image/capabilities.ts";

type PendingTerminalColorQuery = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette: Array<RgbColor | undefined>;
	/** Targets that already replied, so duplicates do not count twice. */
	replied: Set<string>;
	/**
	 * Receives the result: the promise's resolve until the timeout, then `onLateReply`. Unset once the
	 * query completed (on the DA1 reply or once every color replied); later replies are ignored.
	 */
	deliver: ((colors: TerminalColors) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

const TERMINAL_PALETTE_SIZE = 16;
/** OSC 10 and 11 plus OSC 4 for every palette color. */
const TERMINAL_COLOR_REPLY_COUNT = 2 + TERMINAL_PALETTE_SIZE;
/**
 * Default colors, palette colors 0-15, and a trailing primary device attributes (DA1) request.
 * Every terminal answers DA1 and terminals answer in order, so the DA1 reply marks the end of
 * the color replies, including for terminals that ignore the color queries.
 */
const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: TERMINAL_PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}${DEVICE_ATTRIBUTES_QUERY}`;

/** What the queries need from the TUI that owns them. */
export interface TerminalQueriesHost {
	terminal(): Terminal;
	isStopped(): boolean;
	/** The terminal reported a new cell size: re-render so images use it. */
	onCellSizeChanged(): void;
	/** The terminal answered a latency probe (`CSI 0 n`). */
	onFenceReply?(): void;
}

/**
 * Questions the TUI asks the terminal (theme colors, cell size) and the color scheme change
 * reports it subscribes to, plus the replies that come back through the input stream.
 */
export class TerminalQueries {
	private readonly host: TerminalQueriesHost;
	/**
	 * Color queries waiting for their DA1 reply, oldest first. Terminals answer in order, so color
	 * replies belong to the oldest one. Queries stay here after a timeout to collect late replies.
	 */
	private pendingColorQueries: PendingTerminalColorQuery[] = [];
	private colorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private colorSchemeNotificationsEnabled = false;

	constructor(host: TerminalQueriesHost) {
		this.host = host;
	}

	/** The terminal started: resume color scheme reports if they were requested. */
	start(): void {
		if (this.colorSchemeNotificationsEnabled) this.writeColorSchemeMode(true);
	}

	/** The TUI is stopping: turn color scheme reports off, leaving the request for the next start. */
	stop(): void {
		if (this.colorSchemeNotificationsEnabled) this.writeColorSchemeMode(false);
		for (const query of this.pendingColorQueries.splice(0)) {
			if (query.timer) this.completeTerminalColorQuery(query);
			else query.deliver = undefined;
		}
	}

	onColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.colorSchemeListeners.add(listener);
		return () => {
			this.colorSchemeListeners.delete(listener);
		};
	}

	setColorSchemeNotifications(enabled: boolean): void {
		if (this.colorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.colorSchemeNotificationsEnabled = enabled;
		if (!this.host.isStopped()) this.writeColorSchemeMode(enabled);
	}

	/** Turn terminal color scheme change reports (DEC mode 2031) on or off. */
	private writeColorSchemeMode(enabled: boolean): void {
		this.host.terminal().write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
	}

	queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.host.terminal().write("\x1b[16t");
	}

	/**
	 * Take terminal replies out of the input stream. Replies are protocol, not user input: input
	 * listeners never see or alter them. Returns whether `data` was one.
	 */
	consumeReply(data: string): boolean {
		// A probe's answer is protocol even when no probe waits (a reply that came after the fence stopped).
		if (data === FENCE_REPLY) {
			this.host.onFenceReply?.();
			return true;
		}
		return (
			this.consumeTerminalColorResponse(data) ||
			this.consumeTerminalColorSchemeReport(data) ||
			this.consumeCellSizeResponse(data)
		);
	}

	private consumeTerminalColorResponse(data: string): boolean {
		const query = this.pendingColorQueries[0];
		if (!query) {
			return false;
		}
		if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)) {
			this.pendingColorQueries.shift();
			this.completeTerminalColorQuery(query);
			return true;
		}

		const response = parseOscColorResponse(data);
		if (!response) {
			return false;
		}
		const { target, rgb } = response;
		const key = String(target);
		if (!query.deliver || query.replied.has(key)) {
			return true;
		}
		query.replied.add(key);
		if (target === "foreground") {
			query.foreground = rgb;
		} else if (target === "background") {
			query.background = rgb;
		} else if (target < TERMINAL_PALETTE_SIZE) {
			query.palette[target] = rgb;
		}
		if (query.replied.size === TERMINAL_COLOR_REPLY_COUNT) {
			this.completeTerminalColorQuery(query);
		}
		return true;
	}

	private terminalColorQueryResult(query: PendingTerminalColorQuery): TerminalColors {
		const palette = query.palette.every((color) => color !== undefined) ? query.palette : undefined;
		return { foreground: query.foreground, background: query.background, palette };
	}

	private completeTerminalColorQuery(query: PendingTerminalColorQuery): void {
		const deliver = query.deliver;
		query.deliver = undefined;
		clearTimeout(query.timer);
		query.timer = undefined;
		deliver?.(this.terminalColorQueryResult(query));
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.colorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.host.onCellSizeChanged();
		return true;
	}

	/**
	 * Query the terminal's theme colors: the default foreground (OSC 10), the default background
	 * (OSC 11), and ANSI colors 0-15 (OSC 4), followed by a DA1 request that marks the end of the
	 * replies. Resolves when the DA1 reply or all color replies arrive, or when the timeout expires.
	 * Colors the terminal did not report are undefined; the palette is only set when all 16 arrived.
	 * @param timeoutMs Query timeout in milliseconds, for terminals that do not answer DA1 either.
	 * @param onLateReply Receives the replies if the query completes after the timeout, e.g. over slow links.
	 */
	queryColors({
		timeoutMs,
		onLateReply,
	}: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return new Promise((resolve) => {
			const query: PendingTerminalColorQuery = {
				palette: Array.from({ length: TERMINAL_PALETTE_SIZE }, () => undefined),
				replied: new Set(),
				deliver: resolve,
				timer: undefined,
			};
			// Resolve with the replies so far, and keep collecting late replies for `onLateReply`.
			query.timer = setTimeout(() => {
				query.timer = undefined;
				query.deliver = onLateReply;
				resolve(this.terminalColorQueryResult(query));
			}, timeoutMs);
			this.pendingColorQueries.push(query);
			this.host.terminal().write(TERMINAL_COLOR_QUERY);
		});
	}
}
