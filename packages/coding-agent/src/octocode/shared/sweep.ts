import fs from "node:fs";
import path from "node:path";

/** Aged output folders (listed for the sweep to remove), and moving a file across file systems. */

/**
 * Paths of the entries of `dir` not modified for `maxAgeMs`, except those named in `keep`; nothing when `dir` is missing,
 * not a real directory (a link to one is not followed) or unreadable. Age is the entry's own (`lstat`), so a link is
 * judged by the link, never by its target. Never rejects.
 */
export async function staleEntries(
	dir: string,
	maxAgeMs: number,
	keep: ReadonlySet<string> = new Set(),
	now = Date.now(),
): Promise<string[]> {
	let names: string[];
	try {
		if (!(await fs.promises.lstat(dir)).isDirectory()) return [];
		names = await fs.promises.readdir(dir);
	} catch {
		return [];
	}
	const stale: string[] = [];
	for (const name of names) {
		if (keep.has(name)) continue;
		const file = path.join(dir, name);
		try {
			if (now - (await fs.promises.lstat(file)).mtimeMs > maxAgeMs) stale.push(file);
		} catch {
			// Removed meanwhile.
		}
	}
	return stale;
}

/** Moves a file, copying across file systems; returns false when it could not. */
export function moveFile(from: string, to: string): boolean {
	try {
		fs.renameSync(from, to);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") return false;
		try {
			fs.copyFileSync(from, to);
			fs.rmSync(from, { force: true });
			return true;
		} catch {
			return false;
		}
	}
}
