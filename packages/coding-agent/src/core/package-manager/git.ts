import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { GitSource } from "../../utils/git.ts";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import { ensureGitIgnore, getGitDependencyInstallArgs, runNpmCommand } from "./npm.ts";
import { assertProjectTrustedForScope, getTemporaryDir, resolveManagedPath } from "./sources.ts";
import { NETWORK_TIMEOUT_MS, type PackageManagerHost, type SourceScope } from "./types.ts";
import { readJsonFile } from "@octocodeai/octocode-common/json";

export async function installGit(host: PackageManagerHost, source: GitSource, scope: SourceScope): Promise<void> {
	const targetDir = getGitInstallPath(host, source, scope);
	if (existsSync(targetDir)) {
		if (source.ref) {
			await ensureGitRef(host, targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}
		const target = await host.getLocalGitUpdateTarget(targetDir);
		await ensureGitRef(host, targetDir, target.fetchArgs, target.ref);
		return;
	}
	const gitRoot = getGitInstallRoot(host, scope);
	if (gitRoot) {
		ensureGitIgnore(gitRoot);
	}
	mkdirSync(dirname(targetDir), { recursive: true });
	rmSync(getGitUpdateMarkerPath(targetDir), { force: true });

	try {
		await host.runCommand("git", ["clone", source.repo, targetDir]);
		if (source.ref) {
			await host.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await runNpmCommand(host, getGitDependencyInstallArgs(host), { cwd: targetDir });
		}
	} catch (error) {
		rmSync(targetDir, { recursive: true, force: true });
		pruneEmptyGitParents(targetDir, gitRoot);
		throw error;
	}
}

export async function updateGit(host: PackageManagerHost, source: GitSource, scope: SourceScope): Promise<void> {
	const targetDir = getGitInstallPath(host, source, scope);
	if (!existsSync(targetDir)) {
		await installGit(host, source, scope);
		return;
	}

	if (source.ref) {
		await ensureGitRef(host, targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
		return;
	}

	const target = await host.getLocalGitUpdateTarget(targetDir);
	await ensureGitRef(host, targetDir, target.fetchArgs, target.ref);
}

function hasMissingGitDependencies(targetDir: string): boolean {
	const packageJsonPath = join(targetDir, "package.json");
	if (!existsSync(packageJsonPath)) return false;

	try {
		const manifest = readJsonFile<{ dependencies?: unknown }>(packageJsonPath);
		if (!manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies)) {
			return false;
		}

		const nodeModulesDir = resolve(targetDir, "node_modules");
		return Object.keys(manifest.dependencies).some((name) => {
			const dependencyPath = resolve(nodeModulesDir, name);
			if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
			return !existsSync(dependencyPath);
		});
	} catch {
		return false;
	}
}

async function repairMissingGitDependencies(host: PackageManagerHost, targetDir: string): Promise<void> {
	if (!hasMissingGitDependencies(targetDir)) return;
	await runNpmCommand(host, getGitDependencyInstallArgs(host), { cwd: targetDir });
}

function getGitUpdateMarkerPath(targetDir: string): string {
	return join(dirname(targetDir), `.${basename(targetDir)}.octocode-update-incomplete`);
}

async function cleanAndInstallGitDependencies(
	host: PackageManagerHost,
	targetDir: string,
	markerPath: string,
): Promise<void> {
	// Clean untracked files (extensions should be pristine). If this fails after
	// deleting dependencies, repair them so the existing extension still loads.
	try {
		await host.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
	} catch (error) {
		await repairMissingGitDependencies(host, targetDir).catch(() => {});
		throw error;
	}

	const packageJsonPath = join(targetDir, "package.json");
	if (existsSync(packageJsonPath)) {
		await runNpmCommand(host, getGitDependencyInstallArgs(host), { cwd: targetDir });
	}
	rmSync(markerPath, { force: true });
}

async function ensureGitRef(
	host: PackageManagerHost,
	targetDir: string,
	fetchArgs: string[],
	ref: string,
): Promise<void> {
	// Fetch only the ref we will reset to, avoiding unrelated branch/tag noise.
	await host.runCommand("git", fetchArgs, { cwd: targetDir });

	const localHead = await host.runCommandCapture("git", ["rev-parse", "HEAD"], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const commitRef = `${ref}^{commit}`;
	const targetHead = await host.runCommandCapture("git", ["rev-parse", commitRef], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const markerPath = getGitUpdateMarkerPath(targetDir);
	if (localHead.trim() === targetHead.trim()) {
		if (existsSync(markerPath)) {
			await cleanAndInstallGitDependencies(host, targetDir, markerPath);
		} else {
			await repairMissingGitDependencies(host, targetDir);
		}
		return;
	}

	writeFileSync(markerPath, "", "utf-8");
	await host.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });
	await cleanAndInstallGitDependencies(host, targetDir, markerPath);
}

export async function refreshTemporaryGitSource(
	host: PackageManagerHost,
	source: GitSource,
	sourceStr: string,
): Promise<void> {
	if (isOfflineModeEnabled()) {
		return;
	}
	try {
		await host.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
			await host.updateGit(source, "temporary");
		});
	} catch {
		// Keep cached temporary checkout if refresh fails.
	}
}

export async function removeGit(host: PackageManagerHost, source: GitSource, scope: SourceScope): Promise<void> {
	const targetDir = getGitInstallPath(host, source, scope);
	rmSync(targetDir, { recursive: true, force: true });
	rmSync(getGitUpdateMarkerPath(targetDir), { force: true });
	pruneEmptyGitParents(targetDir, getGitInstallRoot(host, scope));
}

function pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
	if (!installRoot) return;
	const resolvedRoot = resolve(installRoot);
	let current = dirname(targetDir);
	while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
		if (!existsSync(current)) {
			current = dirname(current);
			continue;
		}
		const entries = readdirSync(current);
		if (entries.length > 0) {
			break;
		}
		try {
			rmSync(current, { recursive: true, force: true });
		} catch {
			break;
		}
		current = dirname(current);
	}
}

export function getGitInstallPath(host: PackageManagerHost, source: GitSource, scope: SourceScope): string {
	if (scope === "temporary") {
		// Include the ref in the hash so each pinned ref gets its own checkout.
		return getTemporaryDir(host, `git-${source.host}`, source.path, source.ref);
	}
	const installRoot = getGitInstallRoot(host, scope);
	if (!installRoot) {
		throw new Error("Missing git install root");
	}
	return resolveManagedPath(installRoot, source.host, source.path);
}

function getGitInstallRoot(host: PackageManagerHost, scope: SourceScope): string | undefined {
	if (scope === "temporary") {
		return undefined;
	}
	if (scope === "project") {
		assertProjectTrustedForScope(host, scope);
		return join(host.cwd, CONFIG_DIR_NAME, "git");
	}
	return join(host.agentDir, "git");
}

export async function gitHasAvailableUpdate(host: PackageManagerHost, installedPath: string): Promise<boolean> {
	if (isOfflineModeEnabled()) {
		return false;
	}

	try {
		const localHead = await host.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const remoteHead = await getRemoteGitHead(host, installedPath);
		return localHead.trim() !== remoteHead.trim();
	} catch {
		return false;
	}
}

async function getRemoteGitHead(host: PackageManagerHost, installedPath: string): Promise<string> {
	const upstreamRef = await getGitUpstreamRef(host, installedPath);
	if (upstreamRef) {
		const remoteHead = await runGitRemoteCommand(host, installedPath, ["ls-remote", "origin", upstreamRef]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
		if (match?.[1]) {
			return match[1];
		}
	}

	const remoteHead = await runGitRemoteCommand(host, installedPath, ["ls-remote", "origin", "HEAD"]);
	const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
	if (!match?.[1]) {
		throw new Error("Failed to determine remote HEAD");
	}
	return match[1];
}

export async function getLocalGitUpdateTarget(
	host: PackageManagerHost,
	installedPath: string,
): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
	try {
		const upstream = await host.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const trimmedUpstream = upstream.trim();
		if (!trimmedUpstream.startsWith("origin/")) {
			throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
		}
		const branch = trimmedUpstream.slice("origin/".length);
		if (!branch) {
			throw new Error("Missing upstream branch name");
		}
		const head = await host.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return {
			ref: "@{upstream}",
			head,
			fetchArgs: ["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
		};
	} catch {
		await host.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
		const head = await host.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const originHeadRef = await host
			.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			})
			.catch(() => "");
		const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
		if (branch) {
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
			};
		}
		return {
			ref: "origin/HEAD",
			head,
			fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
		};
	}
}

async function getGitUpstreamRef(host: PackageManagerHost, installedPath: string): Promise<string | undefined> {
	try {
		const upstream = await host.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const trimmed = upstream.trim();
		if (!trimmed.startsWith("origin/")) {
			return undefined;
		}
		const branch = trimmed.slice("origin/".length);
		return branch ? `refs/heads/${branch}` : undefined;
	} catch {
		return undefined;
	}
}

function runGitRemoteCommand(host: PackageManagerHost, installedPath: string, args: string[]): Promise<string> {
	return host.runCommandCapture("git", args, {
		cwd: installedPath,
		timeoutMs: NETWORK_TIMEOUT_MS,
		env: {
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}
