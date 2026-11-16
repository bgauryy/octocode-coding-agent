import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ghLoggedIn } from "../../shared/gh-login.ts";
import { workspaceOctocodeDir } from "../../shared/home.ts";

/** How long a token answer stays: logging in or out shows within a minute, and a repaint never reads the disk. */
const TTL_MS = 60_000;
let cached: { at: number; present: boolean } | undefined;

/**
 * Whether Octocode's GitHub tools have a token to use: `GH_TOKEN`/`GITHUB_TOKEN`, a `gh` login, or Octocode's own
 * stored credentials. Read locally and never validated over the network, so it says a token is there, not that it works.
 */
export function githubTokenPresent(now = Date.now(), env = process.env, home = os.homedir()): boolean {
	if (cached && now - cached.at < TTL_MS) return cached.present;
	const present = ghLoggedIn(env, process.platform === "win32", home) || storedCredentials(home);
	cached = { at: now, present };
	return present;
}

/** Forget the cached answer (tests, or after `/login`). */
export function resetGithubToken(): void {
	cached = undefined;
}

function storedCredentials(home: string): boolean {
	try {
		return fs.statSync(path.join(workspaceOctocodeDir(home), "credentials.json")).size > 0;
	} catch {
		// No stored credentials: the expected state before an Octocode login.
		return false;
	}
}
