import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Names a failing stage before the last one of a pipeline: `cmd | tail` exits with `tail`'s status, so a failing `cmd`
 * would read as success, and forcing `pipefail` would turn `cmd | head` into a failure. After the user's command a
 * trailer records bash's `PIPESTATUS` (zsh's `pipestatus`) to a file without touching the exit code or the output.
 *
 * Limits: only the last pipeline the shell ran is reported (for a compound command, the last one inside it); a command
 * that ends the shell itself (`exit N`, an untrapped signal) or runs where the file cannot be written reports nothing.
 */

/** Exit status of a producer whose reader closed the pipe early (128 + SIGPIPE): the normal end of `cmd | head`. */
const SIGPIPE_EXIT = 141;

/** A command with no `|` has no pipeline stages: it runs unchanged. */
function hasPipe(command: string): boolean {
	return command.includes("|");
}

/** The command with the trailer that writes the last pipeline's statuses to `file`, then restores the command's exit code. */
function withPipeStatus(command: string, file: string): string {
	const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
	return [
		command,
		`__oc_rc=$? __oc_ps="\${PIPESTATUS[*]-}\${pipestatus[*]-}"`,
		`printf '%s' "$__oc_ps" > ${quoted} 2>/dev/null`,
		`unset __oc_ps; (exit $__oc_rc)`,
	].join("\n");
}

/** The note naming each failing stage before the last, or undefined when every such stage succeeded or ended by SIGPIPE. */
export function pipeStatusNote(statuses: string): string | undefined {
	const codes = statuses.trim().split(/\s+/).filter(Boolean).map(Number);
	if (codes.length < 2 || codes.some((code) => !Number.isInteger(code))) return undefined;
	const failed = codes
		.slice(0, -1)
		.map((code, index) => ({ code, stage: index + 1 }))
		.filter(({ code }) => code !== 0 && code !== SIGPIPE_EXIT);
	if (failed.length === 0) return undefined;
	return failed.map(({ stage, code }) => `stage ${stage} of ${codes.length} exited ${code}`).join("; ");
}

/** A status file for one foreground call, and what reads and removes it. */
export interface PipeStatusCapture {
	script(command: string): string;
	/** The note for the finished command; always removes the file. */
	finish(): string | undefined;
}

/** Why `dir` cannot hold the file: something that is no folder sits there, or the folder is not writable. */
const UNWRITABLE = new Set(["EEXIST", "ENOTDIR", "EACCES", "EPERM", "EROFS"]);

/** A capture that reports nothing, for a command that runs where the status file cannot be written. */
const NO_CAPTURE: PipeStatusCapture = { script: (command) => command, finish: () => undefined };

export function capturePipeStatus(dir: string): PipeStatusCapture {
	try {
		mkdirSync(dir, { recursive: true });
	} catch (error) {
		if (UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? "")) return NO_CAPTURE;
		throw error;
	}
	const file = join(dir, `pipestatus-${randomUUID()}`);
	return {
		script: (command) => (hasPipe(command) ? withPipeStatus(command, file) : command),
		finish() {
			try {
				return pipeStatusNote(readFileSync(file, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			} finally {
				rmSync(file, { force: true });
			}
		},
	};
}
