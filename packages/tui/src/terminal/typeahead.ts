import * as fs from "node:fs";

/**
 * Lines typed before the terminal UI switched the terminal to raw mode. Until then the terminal is in its line mode:
 * each Enter ends a line (sent as a line feed, the terminal's carriage-return translation) and the line waits in the
 * terminal's input queue. Read raw, that line feed would be a newline key, not Enter, so a prompt typed while the app
 * started would sit in the editor unsent. Only complete lines are read here, through a nonblocking descriptor of its
 * own (nothing waits): a line still being typed stays queued and arrives as raw keys after the switch. Empty when stdin
 * is not a pseudo-terminal, on Windows, or when anything fails.
 */
export function readTypedLines(): string {
	if (process.platform === "win32" || !process.stdin.isTTY) return "";
	let fd: number;
	try {
		const device = stdinDevice();
		if (!device) return "";
		fd = fs.openSync(device, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
	} catch {
		return "";
	}
	const chunks: Buffer[] = [];
	try {
		const buffer = Buffer.alloc(4096);
		for (;;) {
			let read: number;
			try {
				read = fs.readSync(fd, buffer, 0, buffer.length, null);
			} catch {
				break; // EAGAIN: no complete line is left.
			}
			// Zero is an end-of-file key (Ctrl+D) on an empty line: nothing to forward.
			if (read <= 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, read)));
		}
	} catch {
		// What was read so far is still the user's input.
	} finally {
		fs.closeSync(fd);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * The path of the pseudo-terminal stdin reads (`/dev/ttys<n>` on macOS, `/dev/pts/<n>` on Linux), proven by its device
 * number: opened again, it gets a nonblocking descriptor of its own. Undefined for any other terminal.
 */
function stdinDevice(): string | undefined {
	const { rdev } = fs.fstatSync(0);
	const candidate =
		process.platform === "darwin"
			? `/dev/ttys${String(rdev & 0xffffff).padStart(3, "0")}`
			: `/dev/pts/${(((rdev >>> 8) & 0xfff) - 136) * 256 + ((rdev & 0xff) | ((rdev >>> 12) & 0xfff00))}`;
	try {
		return fs.statSync(candidate).rdev === rdev ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Typed-ahead lines as raw key input: the line feeds ending them become one Enter (a carriage return), so the text
 * is submitted once however many times Enter was pressed; line feeds between lines stay newlines of one prompt. Only
 * Enters (no text) are dropped.
 */
export function typedAheadInput(lines: string): string {
	const text = lines.replace(/\n+$/, "");
	if (text.length === lines.length) return lines;
	return text ? `${text}\r` : "";
}
