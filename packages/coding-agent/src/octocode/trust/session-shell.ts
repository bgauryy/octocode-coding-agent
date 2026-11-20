import { execFileSync } from "node:child_process";
import { isProcessTitle } from "../shared/process-title.ts";

/**
 * Trust is the user's decision, so a command that records it must not be one the agent can run. The bash tool gives its
 * children `OCTOCODE_SESSION_ID`; a process that has it runs inside a session's shell, where `octocode trust add --yes`
 * or `--trust` would let the model grant trust to any folder it can name. The commands that record a decision on the
 * user's behalf refuse there. Code inside Octocode that records through the user's answer (the worktree question, the
 * trust prompt, the user's own `/trust`) calls the grant functions directly and is not affected.
 */

/**
 * Whether this process was started from the shell of an Octocode session (or one of its subagents). By presence, not
 * value: `OCTOCODE_SESSION_ID= octocode trust add` is the same shell. `belowSession` covers a variable removed outright.
 */
export function insideSessionShell(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OCTOCODE_SESSION_ID !== undefined;
}

/** How far up the process tree a session is looked for: deeper than any shell, wrapper and script chain in practice. */
const MAX_ANCESTORS = 32;

/** One process's parent and command, from `ps`; undefined when it cannot say (no `ps`, as on Windows, or no such process). */
function processRow(pid: number): { ppid: number; command: string } | undefined {
	try {
		const row = /^\s*(\d+)\s+(.*)$/s.exec(
			execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
		return row ? { ppid: Number(row[1]), command: row[2] ?? "" } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a running session is among this process's ancestors. Unlike a variable, a command in a session's shell cannot
 * unset this. It costs up to one `ps` per ancestor, so it is for the rare command that records trust. Fails open: a
 * platform that cannot say keeps today's check of the variable.
 */
export function belowSession(start: number = process.ppid, row = processRow): boolean {
	let pid = start;
	for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
		const found = row(pid);
		if (!found) return false;
		if (isProcessTitle(found.command)) return true;
		pid = found.ppid;
	}
	return false;
}

/** Why a command refused to record trust inside a session's shell, and what the user does instead. */
export function sessionShellRefusal(attempt: string): string {
	return `Octocode did not ${attempt}: this command runs inside an Octocode session's shell, and trust is your decision, not the agent's. Run it yourself in your own terminal (outside the session).`;
}
