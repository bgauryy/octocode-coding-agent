import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { flushRawStdout } from "../core/output-guard.ts";

/**
 * Turns an uncaught exception or unhandled rejection in print, json, rpc and acp mode into one error line and a
 * non-zero exit. Without a listener Node prints a stack trace (which can carry secrets from error messages) and leaves
 * any terminal mode this process switched on. Interactive mode owns its own handlers.
 */

/** Cursor visible, mouse and focus reporting off, bracketed paste off, alternate screen left, keyboard protocol popped. */
export const TERMINAL_RESET =
	"\x1b[?25h\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[<u\x1b[?1049l";

const FLUSH_DEADLINE_MS = 1000;

export interface HeadlessCrashPorts {
	/** Whether the process owns a terminal whose modes need restoring. */
	isTty: boolean;
	writeTerminal: (text: string) => void;
	writeError: (line: string) => void;
	flush: () => Promise<void>;
	exit: (code: number) => void;
}

const processPorts: HeadlessCrashPorts = {
	isTty: process.stdout.isTTY ?? false,
	writeTerminal: (text) => void process.stdout.write(text),
	writeError: (line) => void process.stderr.write(line),
	flush: flushRawStdout,
	exit: (code) => process.exit(code),
};

/** The one-line, secret-free description of a crash. */
export function crashLine(kind: string, error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const first = redactSecrets(text.split(/\r?\n/, 1)[0] ?? "").slice(0, 300);
	return `Octocode stopped on an unexpected error (${kind}): ${first || "no message"}\n`;
}

/** Installs the handlers and returns the function that removes them. */
export function installHeadlessCrashHandlers(ports: HeadlessCrashPorts = processPorts): () => void {
	let crashing = false;
	const crash = (kind: string, error: unknown): void => {
		if (crashing) return;
		crashing = true;
		if (ports.isTty) ports.writeTerminal(TERMINAL_RESET);
		ports.writeError(crashLine(kind, error));
		let deadline: NodeJS.Timeout | undefined;
		const expired = new Promise<void>((resolve) => {
			deadline = setTimeout(resolve, FLUSH_DEADLINE_MS);
		});
		void Promise.race([ports.flush(), expired])
			.catch(() => {})
			.finally(() => {
				clearTimeout(deadline);
				ports.exit(1);
			});
	};
	const onException = (error: Error) => crash("uncaughtException", error);
	const onRejection = (reason: unknown) => crash("unhandledRejection", reason);
	process.prependListener("uncaughtException", onException);
	process.prependListener("unhandledRejection", onRejection);
	return () => {
		process.off("uncaughtException", onException);
		process.off("unhandledRejection", onRejection);
	};
}
