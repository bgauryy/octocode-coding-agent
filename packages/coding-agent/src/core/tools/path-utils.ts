import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

/** Ordered filename variants shared by synchronous tracking and asynchronous reads. */
function readPathCandidates(resolved: string): string[] {
	const nfd = resolved.normalize("NFD");
	return [
		...new Set([
			resolved,
			resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
			nfd,
			resolved.replace(/'/g, "\u2019"),
			nfd.replace(/'/g, "\u2019"),
		]),
	];
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	return readPathCandidates(resolved).find(fileExists) ?? resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);
	for (const candidate of readPathCandidates(resolved)) {
		if (await pathExists(candidate)) return candidate;
	}
	return resolved;
}
