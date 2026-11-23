import { closeSync, constants, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";
import { assertSessionCwdExists, MissingSessionCwdError } from "../session-cwd.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../session-manager.ts";
import { parseSessionEntryLine } from "../session-manager/entries.ts";
import { readSessionHeaderForDiscovery } from "../session-manager/storage.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

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

/** How much of a file the check reads to name its first line: a session file's header comes first. */
const FIRST_LINE_PROBE_BYTES = 64 * 1024;

/** The first line of `file` that holds something, with its 1-based number, when it starts within the probe. */
function firstRecordLine(file: string): { number: number; text: string } | undefined {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(FIRST_LINE_PROBE_BYTES);
		const lines = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0)).split("\n");
		const index = lines.findIndex((line) => line.trim() !== "");
		return index < 0 ? undefined : { number: index + 1, text: lines[index] };
	} finally {
		closeSync(fd);
	}
}

/**
 * Why the existing file at `resolvedPath` is not a session this Octocode can import, naming the line at fault; undefined
 * when it is one. Reads only the start of the file, so it runs before anything is asked, copied or torn down.
 */
export function sessionFileProblem(resolvedPath: string): string | undefined {
	if (!statSync(resolvedPath).isFile()) return "it is not a file";
	const header = readSessionHeaderForDiscovery(resolvedPath);
	if (header) {
		if (header.version === CURRENT_SESSION_VERSION) return undefined;
		const found = header.version === undefined ? "no version" : `version ${header.version}`;
		return `its header has ${found}; this Octocode reads version ${CURRENT_SESSION_VERSION} only`;
	}
	const first = firstRecordLine(resolvedPath);
	if (!first) return "it is empty";
	const entry = parseSessionEntryLine(first.text) as { type?: unknown } | null;
	if (!entry) return `line ${first.number} is not JSON`;
	const what = typeof entry.type === "string" ? `a "${entry.type}" record` : "not a session record";
	return `line ${first.number} is ${what}, and a session file starts with its "session" header`;
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
export async function openImportedSession(
	resolvedPath: string,
	destination: { destinationPath: string; sourceAlreadyStored: boolean },
	options: { sessionDir: string; cwdOverride?: string; cwd: string },
): Promise<SessionManager> {
	const { destinationPath, sourceAlreadyStored } = destination;
	if (!sourceAlreadyStored) {
		await copyFile(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
	}

	let sessionManager: SessionManager;
	try {
		sessionManager = await SessionManager.openAsync(destinationPath, options.sessionDir, options.cwdOverride);
		assertSessionCwdExists(sessionManager, options.cwd);
	} catch (error) {
		if (!sourceAlreadyStored) await rm(destinationPath, { force: true });
		if (error instanceof MissingSessionCwdError) throw error;
		throw new SessionImportInvalidError(resolvedPath, error);
	}
	return sessionManager;
}
