import fs from "node:fs";
import path from "node:path";

export interface PackageManifest {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
	dependencies?: unknown;
}

/** The parsed `package.json` at `file`, or undefined when it is absent or not JSON. */
export function readManifest(file: string): PackageManifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as PackageManifest;
	} catch {
		return undefined;
	}
}

/**
 * The installed folder of package `name` as Node's `node_modules` lookup finds it from `fromDir`: the first
 * `<ancestor>/node_modules/<name>` folder, real path (a `link:` dependency gives its target). It reads no `exports`, so
 * a package that exposes only an `import` entry, hides its `package.json` or has an invalid `exports` field is still
 * found; callers check the manifest. Undefined when no ancestor holds the folder. Never throws.
 */
export function installedPackageDir(fromDir: string, name: string): string | undefined {
	for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
		if (path.basename(dir) !== "node_modules") {
			const candidate = path.join(dir, "node_modules", name);
			try {
				if (fs.statSync(candidate).isDirectory()) return fs.realpathSync(candidate);
			} catch {
				// Absent here (or unreadable, a dangling link, a file in the path): look one level up, as Node does.
			}
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}
