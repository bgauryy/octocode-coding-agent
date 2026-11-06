/**
 * A child process that owns the terminal (the external editor, an interactive `/octocode` subcommand) runs in
 * Octocode's foreground process group with the terminal in cooked mode, so a Ctrl+C reaches Octocode as a SIGINT too.
 * That SIGINT belongs to the child: while a hold is open, the interactive SIGINT handler ignores it, and a no-op
 * listener keeps Node's default SIGINT exit away when no handler is registered.
 */

let holds = 0;
const ignoreSigint = (): void => {};

/** True while a child holds the terminal. */
export function foregroundChildActive(): boolean {
	return holds > 0;
}

/**
 * Marks the terminal as held by a child until the returned release runs. Call release on every exit path (close,
 * spawn error, exception); a second call does nothing.
 */
export function holdTerminalForChild(): () => void {
	if (holds++ === 0) process.on("SIGINT", ignoreSigint);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--holds === 0) process.removeListener("SIGINT", ignoreSigint);
	};
}
