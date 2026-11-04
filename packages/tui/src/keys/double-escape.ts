/**
 * Two Escape presses that arrive in one read (a slow link, SSH, a busy host) are the bytes `\x1b\x1b`, which a
 * terminal in legacy mode also sends for Ctrl+Alt+[ and Alt+Escape, so `parseKey` reads them as `ctrl+alt+[` and an
 * Escape handler never sees them. A terminal with the Kitty keyboard protocol sends the real Ctrl+Alt+[ as a CSI-u
 * sequence (`\x1b[91;7u`), which this does not touch, so only the legacy bytes are ambiguous, and a person who
 * presses Escape twice meant Escape twice far more often than that chord.
 *
 * Returns the key presses to deliver in place of `data`: two Escapes for a bare `\x1b\x1b`, otherwise `data` itself.
 */
export function splitDoubleEscape(data: string): string[] {
	return data === "\x1b\x1b" ? ["\x1b", "\x1b"] : [data];
}
