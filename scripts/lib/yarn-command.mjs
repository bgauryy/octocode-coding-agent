import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The repository's Yarn release, as `.yarnrc.yml` pins it: runs the same Yarn on every platform without corepack. */
function yarnRelease() {
	const yarnPath = readFileSync(join(repoRoot, ".yarnrc.yml"), "utf8").match(/^yarnPath:\s*(\S+)\s*$/m)?.[1];
	if (!yarnPath) throw new Error("Cannot locate Yarn: .yarnrc.yml sets no yarnPath");
	return join(repoRoot, yarnPath);
}

/** Runs a repository task through Yarn, e.g. `execYarnSync(["run", "check"], { cwd })`. */
export function execYarnSync(args, options = {}) {
	return execFileSync(process.execPath, [yarnRelease(), ...args], options);
}

/** Starts a repository task through the same pinned Yarn, leaving output and cancellation to the caller. */
export function spawnYarn(args, options = {}) {
	return spawn(process.execPath, [yarnRelease(), ...args], options);
}
