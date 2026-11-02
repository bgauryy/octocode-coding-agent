import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { addIgnoreRules } from "../../utils/ignore.ts";
import { hasPluginOrSkillMarker, readExtensionManifest } from "../extension-manifest.ts";
import { isIgnored, readDirectoryEntries } from "./discovery.ts";

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json whose `octocode` (or legacy `pi`) manifest declares extensions -> returns the declared paths that exist
 * 2. a plugin or skill marker (see `hasPluginOrSkillMarker`) -> returns no entries (the directory is not an extension)
 * 3. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readExtensionManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	if (hasPluginOrSkillMarker(dir)) return [];

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover the extensions under `dir`. Package auto-discovery lists them only so the loader can report each as ignored.
 *
 * Rules (documented in docs/packages.md, "Extension directory discovery"):
 * 1. If `dir` itself declares entries (`package.json` manifest or `index.ts`/`index.js`), those are the result.
 * 2. Otherwise each top-level `*.ts`/`*.js` file is an extension, and each subdirectory contributes what
 *    {@link resolveExtensionEntries} returns for it.
 * 3. Dot entries, `node_modules` and paths matched by `.gitignore`/`.ignore`/`.fdignore` are skipped.
 *
 * No recursion beyond one level.
 */
export function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];

	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;

	const discovered: string[] = [];
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		for (const entry of readDirectoryEntries(dir, dir)) {
			if (isIgnored(ig, entry)) continue;
			if (entry.isFile && isExtensionFile(entry.name)) {
				discovered.push(entry.fullPath);
			} else if (entry.isDir) {
				const entries = resolveExtensionEntries(entry.fullPath);
				if (entries) discovered.push(...entries);
			}
		}
	} catch {
		// Unreadable directories contribute nothing.
	}

	return discovered;
}
