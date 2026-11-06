import { inspect } from "node:util";

/**
 * Writes a last-resort diagnostic to stderr: for failures no caller can act on (a listener that throws, a background
 * task that fails). Stderr never carries a protocol or answer stream. The error is appended with its stack when it has one.
 */
export function reportToStderr(message: string, error?: unknown): void {
	const detail =
		error === undefined ? "" : ` ${error instanceof Error ? (error.stack ?? error.message) : inspect(error)}`;
	process.stderr.write(`${message}${detail}\n`);
}
