import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hasControlCharacter } from "../utils/chars.ts";
import { buildCompletionValue, parsePathPrefix, toDisplayPath } from "./path-prefix.ts";
import type { AutocompleteItem } from "./types.ts";

function expandHomePath(path: string): string {
	if (path.startsWith("~/")) {
		const expandedPath = join(homedir(), path.slice(2));
		// Preserve trailing slash if original path had one
		return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
	} else if (path === "~") {
		return homedir();
	}
	return path;
}

export async function resolveScopedFuzzyQuery(
	basePath: string,
	rawQuery: string,
): Promise<{ baseDir: string; query: string; displayBase: string } | null> {
	const normalizedQuery = toDisplayPath(rawQuery);
	const slashIndex = normalizedQuery.lastIndexOf("/");
	if (slashIndex === -1) {
		return null;
	}

	const displayBase = normalizedQuery.slice(0, slashIndex + 1);
	const query = normalizedQuery.slice(slashIndex + 1);

	let baseDir: string;
	if (displayBase.startsWith("~/")) {
		baseDir = expandHomePath(displayBase);
	} else if (displayBase.startsWith("/")) {
		baseDir = displayBase;
	} else {
		baseDir = join(basePath, displayBase);
	}

	try {
		if (!(await stat(baseDir)).isDirectory()) {
			return null;
		}
	} catch {
		return null;
	}

	return { baseDir, query, displayBase };
}

export function scopedPathForDisplay(displayBase: string, relativePath: string): string {
	const normalizedRelativePath = toDisplayPath(relativePath);
	if (displayBase === "/") {
		return `/${normalizedRelativePath}`;
	}
	return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
}

/** File and directory suggestions for a path prefix. Reads are asynchronous: a slow or network folder must not hold up key handling. */
export async function getFileSuggestions(basePath: string, prefix: string): Promise<AutocompleteItem[]> {
	try {
		let searchDir: string;
		let searchPrefix: string;
		const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
		let expandedPrefix = rawPrefix;

		// Handle home directory expansion
		if (expandedPrefix.startsWith("~")) {
			expandedPrefix = expandHomePath(expandedPrefix);
		}

		const isRootPrefix =
			rawPrefix === "" ||
			rawPrefix === "./" ||
			rawPrefix === "../" ||
			rawPrefix === "~" ||
			rawPrefix === "~/" ||
			rawPrefix === "/" ||
			(isAtPrefix && rawPrefix === "");

		if (isRootPrefix) {
			// Complete from specified position
			if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
				searchDir = expandedPrefix;
			} else {
				searchDir = join(basePath, expandedPrefix);
			}
			searchPrefix = "";
		} else if (rawPrefix.endsWith("/")) {
			// If prefix ends with /, show contents of that directory
			if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
				searchDir = expandedPrefix;
			} else {
				searchDir = join(basePath, expandedPrefix);
			}
			searchPrefix = "";
		} else {
			const dir = dirname(expandedPrefix);
			const file = basename(expandedPrefix);
			if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
				searchDir = dir;
			} else {
				searchDir = join(basePath, dir);
			}
			searchPrefix = file;
		}

		const entries = await readdir(searchDir, { withFileTypes: true });
		const suggestions: AutocompleteItem[] = [];

		for (const entry of entries) {
			if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
				continue;
			}
			// A name with a control character cannot be typed, and its label would write the escape to the terminal.
			if (hasControlCharacter(entry.name)) continue;

			// Check if entry is a directory (or a symlink pointing to a directory)
			let isDirectory = entry.isDirectory();
			if (!isDirectory && entry.isSymbolicLink()) {
				try {
					const fullPath = join(searchDir, entry.name);
					isDirectory = (await stat(fullPath)).isDirectory();
				} catch {
					// Broken symlink or permission error - treat as file
				}
			}

			let relativePath: string;
			const name = entry.name;
			const displayPrefix = rawPrefix;

			if (displayPrefix.endsWith("/")) {
				// If prefix ends with /, append entry to the prefix
				relativePath = displayPrefix + name;
			} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
				// Preserve ~/ format for home directory paths
				if (displayPrefix.startsWith("~/")) {
					const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
					const dir = dirname(homeRelativeDir);
					relativePath = `~/${dir === "." ? name : join(dir, name)}`;
				} else if (displayPrefix.startsWith("/")) {
					// Absolute path - construct properly
					const dir = dirname(displayPrefix);
					if (dir === "/") {
						relativePath = `/${name}`;
					} else {
						relativePath = `${dir}/${name}`;
					}
				} else {
					relativePath = join(dirname(displayPrefix), name);
					// path.join normalizes away ./ prefix, preserve it
					if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
						relativePath = `./${relativePath}`;
					}
				}
			} else {
				// For standalone entries, preserve ~/ if original prefix was ~/
				if (displayPrefix.startsWith("~")) {
					relativePath = `~/${name}`;
				} else {
					relativePath = name;
				}
			}

			relativePath = toDisplayPath(relativePath);
			const pathValue = isDirectory ? `${relativePath}/` : relativePath;
			const value = buildCompletionValue(pathValue, {
				isDirectory,
				isAtPrefix,
				isQuotedPrefix,
			});

			suggestions.push({
				value,
				label: name + (isDirectory ? "/" : ""),
				kind: isDirectory ? "directory" : "file",
			});
		}

		suggestions.sort((a, b) => {
			const aIsDir = a.label.endsWith("/");
			const bIsDir = b.label.endsWith("/");
			if (aIsDir && !bIsDir) return -1;
			if (!aIsDir && bIsDir) return 1;
			return a.label.localeCompare(b.label);
		});

		return suggestions;
	} catch (_e) {
		// Directory doesn't exist or not accessible
		return [];
	}
}
