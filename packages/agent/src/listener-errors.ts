/**
 * Receives a listener or event handler that threw or rejected. The library never lets such a failure cost a tool's
 * result or a run, so it only reports it: `message` is one line naming the source, `error` is the thrown value.
 * A host passes its own reporter to route these lines to its diagnostics (a terminal UI must not have raw text drawn
 * over its screen).
 */
export type ListenerErrorReporter = (message: string, error: unknown) => void;

/** The default reporter: one line on `process.stderr` where the runtime has one, otherwise `console.error` (browsers). */
export const reportListenerErrorToStderr: ListenerErrorReporter = (message) => {
	const stderr = (globalThis as { process?: { stderr?: { write(text: string): unknown } } }).process?.stderr;
	if (stderr) {
		stderr.write(`${message}\n`);
		return;
	}
	// oxlint-disable-next-line no-console -- a browser has no stderr; the console is its only diagnostics channel
	console.error(message);
};
