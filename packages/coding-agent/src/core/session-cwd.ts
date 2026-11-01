import { existsSync, statSync } from "node:fs";
import { resolvePath } from "../../../common/src/paths.ts";
import { worktreeRecoveryHint } from "./worktree-path.ts";

export interface SessionCwdIssue {
	sessionFile?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	const hint = worktreeRecoveryHint(issue.sessionCwd);
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}${hint ? `\n${hint}` : ""}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	const hint = worktreeRecoveryHint(issue.sessionCwd);
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\n${hint ? `${hint}\n\n` : ""}continue in current cwd\n${issue.fallbackCwd}`;
}

export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

/** The folder a new session runs in: `requested` (an existing directory; a relative one resolves against `current`) or else `current`. */
export function resolveSessionCwd(current: string, requested: string | undefined): string {
	if (requested === undefined) return current;
	const cwd = resolvePath(requested, current);
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Working directory is not a folder: ${cwd}`);
	return cwd;
}

export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}
