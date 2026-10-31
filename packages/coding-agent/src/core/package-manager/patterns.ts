import { globSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { toPosixPath } from "../../utils/ignore.ts";
import { normalizePath } from "../../../../common/src/paths.ts";

function isPattern(s: string): boolean {
	return isOverridePattern(s) || hasGlobPattern(s);
}

export function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

/** The path an entry names, without its `!`, `+` or `-` override prefix. */
export function overridePatternTarget(entry: string): string {
	return isOverridePattern(entry) ? entry.slice(1) : entry;
}

/** `entries` without any entry naming `pattern`, followed by `+pattern` (enabled) or `-pattern` (disabled). */
export function withTogglePattern(entries: readonly string[], pattern: string, enabled: boolean): string[] {
	const updated = entries.filter((entry) => overridePatternTarget(entry) !== pattern);
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	return updated;
}

export function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
export function expandPackageGlob(pattern: string, root: string): string[] {
	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

/** The forms of `filePath` a pattern can name: relative, base name and absolute; for `SKILL.md`, also its directory's. */
function patternTargets(filePath: string, baseDir: string): { paths: string[]; names: string[] } {
	const paths = [toPosixPath(relative(baseDir, filePath)), toPosixPath(filePath)];
	const names = [basename(filePath)];
	if (names[0] === "SKILL.md") {
		const parentDir = dirname(filePath);
		paths.push(toPosixPath(relative(baseDir, parentDir)), toPosixPath(parentDir));
		names.push(basename(parentDir));
	}
	return { paths, names };
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const { paths, names } = patternTargets(filePath, baseDir);
	const targets = [...paths, ...names];
	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(normalizePath(pattern));
		return targets.some((target) => minimatch(target, normalizedPattern));
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalizePath(normalized));
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const { paths } = patternTargets(filePath, baseDir);
	return patterns.some((pattern) => paths.includes(normalizeExactPattern(pattern)));
}

export function getOverridePatterns(entries: string[]): string[] {
	return entries.filter(isOverridePattern);
}

export function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
export function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

export function applyAutoloadDisabledPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const target = pattern.slice(pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0);
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		for (const filePath of allPaths) {
			if (
				exact ? matchesAnyExactPattern(filePath, [target], baseDir) : matchesAnyPattern(filePath, [target], baseDir)
			) {
				result.set(filePath, enabled);
			}
		}
	}
	return result;
}

/**
 * Whether the `skills` setting leaves a skill file enabled: a matching project entry decides, as for bundled skills,
 * otherwise the global entries do. For skill files that reach the loader without auto-discovery, such as folders an
 * extension adds.
 */
export function isSkillEnabledBySettings(
	filePath: string,
	globalPatterns: readonly string[],
	projectPatterns: readonly string[],
	baseDir: string,
): boolean {
	return (
		applyAutoloadDisabledPatterns([filePath], getOverridePatterns([...projectPatterns]), baseDir).get(filePath) ??
		isEnabledByOverrides(filePath, [...globalPatterns], baseDir)
	);
}
