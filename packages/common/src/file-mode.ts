import fs from "node:fs";

/** Owner-only mode for runtime files (logs, spilled output, checkpoint blobs): they can hold source and secrets. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Creates `dir` (and missing parents) owner-only (0700), and tightens an existing `dir` to 0700: runtime state is
 * not for other users on the machine. A folder this user does not own keeps its mode.
 */
export function privateDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Not ours to change (a shared OCTOCODE_HOME); the files in it are still owner-only.
	}
	return dir;
}
