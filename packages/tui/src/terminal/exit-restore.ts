/**
 * Last-resort terminal restore. A process that ends without stopping its UI (`process.exit()`, an uncaught
 * exception, a signal handler that exits) would leave the shell in the alternate screen with mouse reporting, Kitty
 * key encoding and bracketed paste still on. Each terminal mode registers the synchronous write that undoes it and
 * removes it when the mode is stopped normally; the hooks run on the process `exit` event, most recently registered
 * first, so a mode entered later is left first.
 *
 * A signal that no listener handles ends the process without an `exit` event; the application owns its signals.
 */

import { setTerminalOutputBlocking } from "./output.ts";
import type { Terminal } from "./types.ts";

function writeTerminalRestore(terminal: Terminal, data: string): void {
	if (terminal.writeOnExit) terminal.writeOnExit(data);
	else terminal.write(data);
}

/** Capture the terminal and restore bytes, never the renderer graph whose lifecycle is ending. */
export function registerTerminalRestore(terminal: Terminal, data: string): () => void {
	return registerExitRestore(() => writeTerminalRestore(terminal, data));
}

/** Queued normal cleanup still needs a forced-exit fallback until those bytes have actually drained. */
export function unregisterAfterOutput(terminal: Terminal, dispose: () => void): void {
	if ((terminal.pendingOutputBytes ?? 0) > 0 && terminal.drainOutput)
		void terminal.drainOutput(Infinity).then(dispose, dispose);
	else dispose();
}

const hooks: Array<() => void> = [];
let installed = false;

function runHooks(): void {
	// The event loop will not run again after exit hooks, so restore sequences are written synchronously; stdout stays
	// nonblocking while they are, so a terminal that stopped reading costs a bounded wait (`writeOnExit`), not a hang.
	while (hooks.length > 0) {
		try {
			hooks.pop()?.();
		} catch {
			// Best effort, and never a throw: a terminal that hung up (EIO) takes no restore, the remaining hooks still run,
			// and a throw here would skip the process's later `exit` listeners (the ones that stop child processes).
		}
	}
	// The shell gets the terminal back as it lent it: the nonblocking flag lives on the open file it shares.
	setTerminalOutputBlocking(true);
}

/** Run `restore` on process exit unless the returned function removes it first. `restore` must write synchronously. */
export function registerExitRestore(restore: () => void): () => void {
	hooks.push(restore);
	if (!installed) {
		installed = true;
		process.on("exit", runHooks);
	}
	return () => {
		const index = hooks.lastIndexOf(restore);
		if (index !== -1) hooks.splice(index, 1);
		if (hooks.length === 0 && installed) {
			installed = false;
			process.off("exit", runHooks);
		}
	};
}
