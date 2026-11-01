// Repository paths and path presentation for the coding-agent startup profiler.

import { join, relative, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "..");
export const packageDir = join(repoRoot, "packages", "coding-agent");
export const distCliPath = join(packageDir, "dist", "cli.js");
export const bundledDistCliPath = join(packageDir, "dist", "bundle", "cli.js");
export const srcCliPath = join(packageDir, "src", "cli.ts");
const defaultNodeProfileDir = join(repoRoot, "profiles-node");
const defaultBunProfileDir = join(repoRoot, "profiles-bun");

export function resolveProfileDir(runtime, requestedProfileDir) {
	if (requestedProfileDir) {
		return requestedProfileDir;
	}
	return runtime === "bun" ? defaultBunProfileDir : defaultNodeProfileDir;
}

export function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}
