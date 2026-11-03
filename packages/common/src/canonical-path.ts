import fs from "node:fs";
import path from "node:path";

/**
 * `file` with symlinks resolved, so one file reached through two paths has one name: the realpath of its deepest
 * existing ancestor joined with the rest (the file itself may not exist yet). A dangling symlink on the way is followed
 * to its target, so a write through it is placed where it would land; a symlink loop stops after 40 hops. A `..` is
 * applied after the link before it is followed, as the kernel does (`link/../x` is beside the link's target, not
 * beside the link), never collapsed lexically first.
 */
export function canonicalPath(file: string, hops = 40): string {
	const absolute = PARENT_SEGMENT.test(file) ? withParents(file, hops) : path.resolve(file);
	const rest: string[] = [];
	for (let dir = absolute; ; dir = path.dirname(dir)) {
		try {
			return path.join(fs.realpathSync.native(dir), ...rest.reverse());
		} catch {
			const target = hops > 0 ? linkTarget(dir) : undefined;
			if (target !== undefined)
				return canonicalPath(
					[path.isAbsolute(target) ? target : `${path.dirname(dir)}${path.sep}${target}`, ...rest.reverse()].join(
						path.sep,
					),
					hops - 1,
				);
			const parent = path.dirname(dir);
			if (parent === dir) return absolute;
			rest.push(path.basename(dir));
		}
	}
}

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** `file` made absolute and free of `.`/`..`, walking from the root so each `..` follows the symlinks before it. */
function withParents(file: string, hops: number): string {
	const absolute = path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`;
	const { root } = path.parse(absolute);
	const segments = absolute.slice(root.length).split(path.sep === "\\" ? /[\\/]+/ : /\/+/);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = path.join(current, segment);
		const target = hops > 0 ? linkTarget(next) : undefined;
		if (target === undefined) {
			current = next;
			continue;
		}
		const rest = segments.slice(index + 1);
		return withParents(
			[path.isAbsolute(target) ? target : `${current}${path.sep}${target}`, ...rest].join(path.sep),
			hops - 1,
		);
	}
	return current;
}

/** Where the symlink `file` points (as written in the link), or undefined when it is not a symlink. */
function linkTarget(file: string): string | undefined {
	try {
		return fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : undefined;
	} catch {
		return undefined;
	}
}
