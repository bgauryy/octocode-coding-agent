/**
 * Trust is the user's decision, so a command that records it must not be one the agent can run. The bash tool gives its
 * children `OCTOCODE_SESSION_ID`; a process that has it runs inside a session's shell, where `octocode trust add --yes`
 * or `--trust` would let the model grant trust to any folder it can name. The commands that record a decision on the
 * user's behalf refuse there. Code inside Octocode that records through the user's answer (the worktree question, the
 * trust prompt, the user's own `/trust`) calls the grant functions directly and is not affected.
 */

/** Whether this process was started from the shell of an Octocode session (or one of its subagents). */
export function insideSessionShell(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.OCTOCODE_SESSION_ID?.trim());
}

/** Why a command refused to record trust inside a session's shell, and what the user does instead. */
export function sessionShellRefusal(attempt: string): string {
	return `Octocode did not ${attempt}: this command runs inside an Octocode session's shell, and trust is your decision, not the agent's. Run it yourself in your own terminal (outside the session).`;
}
