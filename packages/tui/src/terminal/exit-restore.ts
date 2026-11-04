/**
 * Last-resort terminal restore. A process that ends without stopping its UI (`process.exit()`, an uncaught
 * exception, a signal handler that exits) would leave the shell in the alternate screen with mouse reporting, Kitty
 * key encoding and bracketed paste still on. Each terminal mode registers the synchronous write that undoes it and
 * removes it when the mode is stopped normally; the hooks run on the process `exit` event, most recently registered
 * first, so a mode entered later is left first.
 *
 * A signal that no listener handles ends the process without an `exit` event; the application owns its signals.
 */

const hooks: Array<() => void> = [];
let installed = false;

function runHooks(): void {
	const errors: unknown[] = [];
	while (hooks.length > 0) {
		try {
			hooks.pop()?.();
		} catch (error) {
			// The remaining hooks still run: one failed write must not leave the other modes on.
			errors.push(error);
		}
	}
	if (errors.length > 0) throw errors[0];
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
