import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { canonicalPath } from "../../../common/src/canonical-path.ts";
import { transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../config/database.ts";
import chalk from "chalk";
import type { Args } from "../cli/args.ts";
import { selectSession } from "../cli/session-picker.ts";
import { showStartupSelector } from "../cli/startup-ui.ts";
import { assertValidSessionId, SessionManager } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { sessionFileRunningPid } from "../octocode/shared/session-liveness.ts";
import { stopThemeWatcher } from "../theme/theme.ts";
import { resolvePath } from "../../../common/src/paths.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { resolveAppMode } from "./startup.ts";

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "stored"; id: string; path: string } // An indexed transcript in another or unavailable checkout
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): { type: "local"; path: string } | undefined {
	const path = SessionManager.findById(cwd, sessionId, sessionDir);
	return path ? { type: "local", path } : undefined;
}

/**
 * The saved session with exactly this id in any project folder (the search `--session <id>` falls back to). `--session-id` and
 * `--fork --session-id` must not reuse it: two files with one id share its output, checkpoint, parked-child and pending-report folders.
 */
async function findSessionFileAnywhere(sessionId: string, sessionDir?: string): Promise<string | undefined> {
	const indexed = storedTranscriptPath(sessionId);
	if (indexed) return indexed;
	return (await SessionManager.listAll(sessionDir)).find((session) => session.id === sessionId)?.path;
}

/** JSONL discovery still works while the database is unavailable. */
function storedTranscriptPath(id: string, sessionDir?: string): string | undefined {
	try {
		const row = transcripts.stamp(sharedAgentDb().db, id);
		return row && (!sessionDir || dirname(row.file) === canonicalPath(sessionDir)) ? row.file : undefined;
	} catch {
		return undefined;
	}
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs only require reading session headers. Fall back to the full
	// metadata listing for prefix matches.
	const exactLocalMatch = findLocalSessionByExactId(sessionArg, cwd, sessionDir);
	if (exactLocalMatch) {
		return exactLocalMatch;
	}

	const stored = storedTranscriptPath(sessionArg, sessionDir);
	const localMatch = (await SessionManager.list(cwd, sessionDir)).find((session) => session.id.startsWith(sessionArg));
	if (!stored && localMatch) return { type: "local", path: localMatch.path };

	const all = await SessionManager.listAll(sessionDir);
	const exact = all.find((session) => session.id === sessionArg);
	if (exact) return { type: "global", path: exact.path, cwd: exact.cwd };
	// An exact historical ID wins over any similarly named live session.
	if (stored) return { type: "stored", id: sessionArg, path: stored };
	const globalMatch = all.find((session) => session.id.startsWith(sessionArg));
	if (globalMatch) return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

export function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

export function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = errorMessage(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = errorMessage(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(
	sourcePath: string | { storedId: string },
	cwd: string,
	sessionDir?: string,
	sessionId?: string,
): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = errorMessage(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

/**
 * The `/resume` check for a session a flag opens: when another live Octocode process has it open, ask as `/resume` does
 * and exit on Cancel. Without a terminal to ask in, the answer is Cancel: two processes appending to one session
 * overwrite each other's history.
 */
async function confirmSessionNotRunning(
	sessionFile: string | undefined,
	parsed: Args,
	settingsManager: SettingsManager,
): Promise<void> {
	const runningPid = sessionFile ? sessionFileRunningPid(sessionFile) : undefined;
	if (runningPid === undefined) return;
	if (resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY) !== "interactive") {
		console.error(
			chalk.red(
				`Error: Another Octocode process (pid ${runningPid}) has this session open: ${sessionFile}. Close it, or fork the session with --fork.`,
			),
		);
		process.exit(1);
	}
	try {
		const confirmed = await showStartupSelector(
			settingsManager,
			`Another Octocode process (pid ${runningPid}) has this session open. Resume it here as well?`,
			[
				{ label: "Resume", value: true },
				{ label: "Cancel", value: false },
			],
		);
		if (!confirmed) {
			console.log(chalk.dim("Resume cancelled"));
			process.exit(0);
		}
	} finally {
		stopThemeWatcher();
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findSessionFileAnywhere(parsed.sessionId, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}': ${existingTarget}`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "stored":
				return forkSessionOrExit({ storedId: resolved.id }, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				await confirmSessionNotRunning(resolved.path, parsed, settingsManager);
				return openSessionOrExit(resolved.path, sessionDir);

			case "global":
			case "stored": {
				console.log(chalk.yellow(`Saved session found at ${resolved.path}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(
					resolved.type === "stored" ? { storedId: resolved.id } : resolved.path,
					cwd,
					sessionDir,
				);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal),
				(onProgress, signal) => SessionManager.listAll(sessionDir, onProgress, signal),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		const recent = SessionManager.continueRecent(cwd, sessionDir);
		await confirmSessionNotRunning(recent.getSessionFile(), parsed, settingsManager);
		return recent;
	}

	if (parsed.sessionId) {
		const existingSession = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			await confirmSessionNotRunning(existingSession.path, parsed, settingsManager);
			return SessionManager.open(existingSession.path, sessionDir);
		}
		const elsewhere = await findSessionFileAnywhere(parsed.sessionId, sessionDir);
		if (elsewhere) {
			console.error(
				chalk.red(
					`Error: Session id '${parsed.sessionId}' already exists in another project folder: ${elsewhere}. Use --session ${parsed.sessionId} to open or fork it here.`,
				),
			);
			process.exit(1);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}
