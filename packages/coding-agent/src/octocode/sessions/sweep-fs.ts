import fs from "node:fs";
import path from "node:path";

/** File-system helpers of the sweep: sizes, idleness and containment. None follows a symbolic link. */

/** Whether `target` is strictly inside `root` by path (never `root` itself). A link inside `root` is judged as a name. */
export function strictlyInside(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** Bytes under `target` (itself when a file or link), counted with `lstat`; entries that vanish or cannot be read count 0. */
export async function pathSize(target: string): Promise<number> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(target);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	const names = await fs.promises.readdir(target).catch((): string[] => []);
	let total = 0;
	for (const name of names) total += await pathSize(path.join(target, name));
	return total;
}

/**
 * Whether nothing at or under `target` was modified after `cutoff` (ms): a folder is as old as its newest file, since a
 * write deep inside does not touch its ancestors. Stops at the first newer entry. Links count by themselves; an entry
 * that cannot be read counts as newer, so an unreadable tree is kept.
 */
export async function idleSince(target: string, cutoff: number): Promise<boolean> {
	try {
		const stat = await fs.promises.lstat(target);
		if (stat.mtimeMs > cutoff) return false;
		if (!stat.isDirectory()) return true;
		for (const name of await fs.promises.readdir(target)) {
			if (!(await idleSince(path.join(target, name), cutoff))) return false;
		}
		return true;
	} catch (error) {
		// Gone meanwhile counts as idle (nothing to keep); anything else is unknown, so kept.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** The `lstat` of `target` when it is a real directory (not a link to one); otherwise undefined. */
export async function realDirectory(target: string): Promise<fs.Stats | undefined> {
	const stat = await fs.promises.lstat(target).catch(() => undefined);
	return stat?.isDirectory() ? stat : undefined;
}
