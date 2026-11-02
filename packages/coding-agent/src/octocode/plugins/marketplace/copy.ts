import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import path from "node:path";
import { sha256Hasher } from "../../../../../common/src/atomic-file.ts";
import { MarketplaceError } from "./source.ts";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Copy a plugin directory (`.git` left out) into `dest`. A symlink is kept only when it resolves to a path inside the
 * plugin; one that leaves it, or points nowhere, stops the copy, so an installed plugin cannot read through the cache
 * into other files. Size and entry limits stop a runaway tree. `root` must be a real path.
 */
export function copyPluginTree(root: string, dest: string): void {
	let entries = 0;
	let bytes = 0;
	const walk = (source: string, target: string) => {
		mkdirSync(target, { recursive: true });
		for (const name of readdirSync(source)) {
			if (name === ".git") continue;
			const from = path.join(source, name);
			const to = path.join(target, name);
			const shown = path.relative(root, from);
			const stat = lstatSync(from);
			if (++entries > MAX_ENTRIES) throw new MarketplaceError(`The plugin has more than ${MAX_ENTRIES} files.`);
			if (stat.isSymbolicLink()) {
				let real: string;
				try {
					real = realpathSync(from);
				} catch {
					throw new MarketplaceError(
						`Plugin file ${shown} is a symlink to ${readlinkSync(from)}, which does not exist.`,
					);
				}
				if (!inside(root, real))
					throw new MarketplaceError(`Plugin file ${shown} is a symlink that leaves the plugin directory.`);
				symlinkSync(path.relative(source, real), to);
			} else if (stat.isDirectory()) walk(from, to);
			else if (stat.isFile()) {
				bytes += stat.size;
				if (bytes > MAX_BYTES) throw new MarketplaceError("The plugin is larger than 256 MiB.");
				copyFileSync(from, to);
			}
		}
	};
	walk(root, dest);
}

/** A short content hash of a directory tree: names, file bytes and link targets in sorted order. */
export function treeHash(root: string): string {
	const hash = sha256Hasher();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = path.join(dir, name);
			const stat = lstatSync(full);
			const relative = path.relative(root, full);
			if (stat.isSymbolicLink()) hash.update(`l\0${relative}\0${readlinkSync(full)}\0`);
			else if (stat.isDirectory()) {
				hash.update(`d\0${relative}\0`);
				walk(full);
			} else if (stat.isFile()) hash.update(`f\0${relative}\0`).update(readFileSync(full)).update("\0");
		}
	};
	walk(root);
	return hash.digest("hex").slice(0, 12);
}
