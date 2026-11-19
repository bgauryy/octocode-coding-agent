import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Bytes a Unix socket path may hold: macOS `sun_path` is 104 including the terminating NUL, Linux 108. The library
 * names its proxy socket `srt-mux-<pid>-<n>.sock` in the system temporary folder; a longer path makes `listen` fail
 * with EINVAL. The name is budgeted at its worst case: a 7-digit pid and a 3-character counter.
 */
const SOCKET_PATH_LIMIT = 103;
const SOCKET_NAME_BUDGET = "srt-mux-9999999-zzz.sock".length;

/** Where the private folder goes: short whatever `TMPDIR` says; `mkdtemp` makes the folder 0700, owned by this account. */
const SHORT_ROOT = "/tmp";

/** True when the library's proxy socket would not fit in the system temporary folder. */
export function tempDirTooLongForSocket(tempDir: string = os.tmpdir()): boolean {
	return Buffer.byteLength(path.join(tempDir, "x".repeat(SOCKET_NAME_BUDGET))) > SOCKET_PATH_LIMIT;
}

/**
 * Runs `start`, the library's initialization, which binds its proxy socket in the system temporary folder. When that
 * folder is too long for a socket path, the socket goes in a short private folder instead: `TMPDIR` names it for the
 * duration of `start` only, then returns to its value. Nothing else changes: commands keep the host's temporary
 * folder, and the sandbox opens no new path (the library, not the command, uses the socket). The folder lives as long
 * as the library's proxy, so it is removed when the process exits, or at once when `start` fails.
 */
export async function withSocketFriendlyTempDir<T>(start: () => Promise<T>): Promise<T> {
	if (!tempDirTooLongForSocket()) return start();
	const dir = fs.mkdtempSync(path.join(SHORT_ROOT, "octocode-sb-"));
	const remove = () => fs.rmSync(dir, { recursive: true, force: true });
	process.once("exit", remove);
	const hostTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = dir;
	try {
		return await start();
	} catch (error) {
		process.off("exit", remove);
		remove();
		throw error;
	} finally {
		if (hostTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = hostTmpdir;
	}
}
