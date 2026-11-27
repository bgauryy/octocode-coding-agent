import { statSync } from "node:fs";

/** Whether `file` is a regular file (following symlinks); false when it is missing or cannot be read. */
export function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		// A missing or unreadable path is the answer, not an error.
		return false;
	}
}

/** Whether `dir` is a directory (following symlinks); false when it is missing or cannot be read. */
export function isDirectory(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		// A missing or unreadable path is the answer, not an error.
		return false;
	}
}
