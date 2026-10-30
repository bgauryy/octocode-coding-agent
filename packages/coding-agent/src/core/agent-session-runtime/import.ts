import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { assertSessionCwdExists, MissingSessionCwdError } from "../session-cwd.ts";
import { SessionManager } from "../session-manager.ts";
import { errorMessage } from "../../utils/guards.ts";

/** The file to import is not a usable session; nothing was copied and the current session is unchanged. */
/** A session name the user typed is empty or too long: a usage problem, not a runtime failure. */
export class SessionNameError extends Error {
	constructor() {
		super("Session name must contain 1–200 characters.");
		this.name = "SessionNameError";
	}
}

export class SessionImportInvalidError extends Error {
	readonly filePath: string;

	constructor(filePath: string, cause: unknown) {
		super(`Not a session file: ${filePath} (${errorMessage(cause)})`, { cause });
		this.name = "SessionImportInvalidError";
		this.filePath = filePath;
	}
}

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

/**
 * Where an imported session file is stored in `sessionDir`, created when missing: its own name, or the
 * first free `name-N` variant. A file already stored there is used in place.
 */
export function prepareImportDestination(
	resolvedPath: string,
	sessionDir: string,
): { destinationPath: string; sourceAlreadyStored: boolean } {
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	let destinationPath = join(sessionDir, basename(resolvedPath));
	const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
	if (!sourceAlreadyStored) {
		const { name, ext } = parse(destinationPath);
		let suffix = 1;
		while (existsSync(destinationPath)) {
			destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
		}
	}
	return { destinationPath, sourceAlreadyStored };
}

/**
 * Copy the file into place and open it. Validates the copy before the current session is torn down;
 * a rejected file leaves no copy behind.
 */
export function openImportedSession(
	resolvedPath: string,
	destination: { destinationPath: string; sourceAlreadyStored: boolean },
	options: { sessionDir: string; cwdOverride?: string; cwd: string },
): SessionManager {
	const { destinationPath, sourceAlreadyStored } = destination;
	if (!sourceAlreadyStored) {
		copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
	}

	let sessionManager: SessionManager;
	try {
		sessionManager = SessionManager.open(destinationPath, options.sessionDir, options.cwdOverride);
		assertSessionCwdExists(sessionManager, options.cwd);
	} catch (error) {
		if (!sourceAlreadyStored) rmSync(destinationPath, { force: true });
		if (error instanceof MissingSessionCwdError) throw error;
		throw new SessionImportInvalidError(resolvedPath, error);
	}
	return sessionManager;
}
