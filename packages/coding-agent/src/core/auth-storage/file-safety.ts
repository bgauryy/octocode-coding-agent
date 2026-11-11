/**
 * Startup checks for an auth.json that exposes API keys: readable by other users, or inside a git work tree where a
 * commit could publish it. A fallback auth.json (the legacy `~/.octocode` folders' or Pi's) is also checked for what
 * Octocode skips in it.
 */

import { statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getLegacyProviderDirs } from "../../config.ts";
import { gitMarkerDir } from "../../utils/git-marker.ts";
import { providerSourceGate } from "../provider-sources/gate.ts";
import { ReadOnlyAuthStorage } from "./read-only.ts";

export interface AuthFileSafetyOptions {
	platform?: NodeJS.Platform;
}

/** What Octocode skips in a fallback auth.json, each naming the file; empty for any other file or with Pi off. */
function fallbackAuthProblems(authPath: string): string[] {
	if (basename(authPath) !== "auth.json" || !providerSourceGate.isEnabled("pi")) return [];
	const dir = resolve(dirname(authPath));
	if (!getLegacyProviderDirs().some((fallback) => resolve(fallback) === dir)) return [];
	return ReadOnlyAuthStorage.problems(authPath);
}

/** Warnings about `authPath`; empty when the file is missing or safe. */
export function checkAuthFileSafety(authPath: string, options: AuthFileSafetyOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	let mode: number;
	try {
		mode = statSync(authPath).mode;
	} catch {
		return [];
	}
	const warnings: string[] = [];
	if (platform !== "win32" && (mode & 0o077) !== 0) {
		warnings.push(
			`${authPath} is readable by other users (mode ${(mode & 0o777).toString(8)}) and may hold API keys. Run: chmod 600 ${authPath}`,
		);
	}
	const workTree = gitMarkerDir(dirname(authPath));
	if (workTree) {
		warnings.push(
			`${authPath} is inside the git work tree ${workTree}; add it to .gitignore so API keys are not committed, or store keys in the system keychain with /providers.`,
		);
	}
	warnings.push(...fallbackAuthProblems(authPath));
	return warnings;
}
