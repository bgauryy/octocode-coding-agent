#!/usr/bin/env node
// Fails when source imports `@octocodeai/<workspace>/<subpath>` and that workspace's package.json `exports` does not
// list the subpath. Tests are skipped: they resolve through source aliases and ship nowhere. tsconfig path wildcards and the source resolver hide the gap until a built or packed consumer fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageDirectories } from "./package-workspaces.mjs";

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED = new Set(["dist", "node_modules", ".git", ".octocode"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
// Only import positions: the same text also appears as Symbol.for keys and in test fixtures.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["'](@octocodeai\/[a-z][\w.-]*)\/([^"'\s]+)["']/g;

function listSources(directory, found = []) {
	if (!existsSync(directory)) return found;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (SKIPPED.has(entry.name) || entry.name === "test") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) listSources(path, found);
		else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) found.push(path);
	}
	return found;
}

function exportPatterns(manifest) {
	const exported = manifest.exports;
	if (!exported || typeof exported !== "object") return [];
	return Object.keys(exported).filter((key) => key.startsWith("./"));
}

function isExported(patterns, subpath) {
	const wanted = `./${subpath}`;
	return patterns.some((pattern) => {
		const star = pattern.indexOf("*");
		if (star === -1) return pattern === wanted;
		return wanted.startsWith(pattern.slice(0, star)) && wanted.endsWith(pattern.slice(star + 1));
	});
}

/** Returns one message per import of a workspace subpath its package does not export. */
export function findMissingSubpaths(repoRoot) {
	const workspaces = new Map();
	for (const directory of findPackageDirectories(join(repoRoot, "packages"))) {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (manifest.name) workspaces.set(manifest.name, exportPatterns(manifest));
	}
	const problems = new Map();
	for (const directory of [join(repoRoot, "packages"), join(repoRoot, "scripts")]) {
		for (const file of listSources(directory)) {
			const text = readFileSync(file, "utf8");
			for (const [, name, subpath] of text.matchAll(SPECIFIER)) {
				const patterns = workspaces.get(name);
				if (!patterns || isExported(patterns, subpath)) continue;
				const key = `${name}/${subpath}`;
				const files = problems.get(key) ?? [];
				files.push(file.slice(repoRoot.length + 1));
				problems.set(key, files);
			}
		}
	}
	return [...problems].map(
		([specifier, files]) =>
			`${specifier} is not in exports (imported by ${files.slice(0, 3).join(", ")}${files.length > 3 ? `, +${files.length - 3} more` : ""})`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const problems = findMissingSubpaths(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	if (problems.length > 0) {
		console.error(
			`Workspace subpath imports missing from package.json exports:\n${problems.map((p) => `  ${p}`).join("\n")}`,
		);
		process.exitCode = 1;
	}
}
