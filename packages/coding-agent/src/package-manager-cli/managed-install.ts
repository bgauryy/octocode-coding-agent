import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME, getPackageDir, VERSION } from "../config.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "../../../common/src/child-process.ts";
import { canonicalizePath, getCwdRelativePath } from "../../../common/src/paths.ts";
import { stripBom } from "../../../common/src/text.ts";
import { getOctocodeUserAgent } from "../utils/user-agent.ts";

const MANAGED_INSTALL_MARKER = "managed-install.json";
const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function getActiveManagedInstallRoot(): string | undefined {
	const configuredRoot = process.env.OCTOCODE_MANAGED_INSTALL_ROOT?.trim();
	if (!configuredRoot) return undefined;

	const managedRoot = resolve(configuredRoot);
	const releasesDir = canonicalizePath(join(managedRoot, "releases"));
	// The launcher environment is inherited by child processes. Do not classify a
	// source checkout or another Octocode installation launched from managed Octocode as managed.
	if (getCwdRelativePath(canonicalizePath(getPackageDir()), releasesDir) === undefined) return undefined;

	const markerPath = join(managedRoot, MANAGED_INSTALL_MARKER);
	try {
		const marker = JSON.parse(stripBom(readFileSync(markerPath, "utf8"))) as {
			kind?: unknown;
			layout?: unknown;
			schemaVersion?: unknown;
		};
		if (marker.kind !== "octocode-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
			throw new Error();
		}
	} catch {
		throw new Error(`Managed install marker is missing or invalid: ${markerPath}`);
	}

	return managedRoot;
}

async function fetchInstallerArtifact(url: string, label: string): Promise<string> {
	const response = await fetch(url, { headers: { "User-Agent": getOctocodeUserAgent(VERSION) } });
	if (!response.ok) {
		throw new Error(`Could not download managed installer ${label} from ${url}: HTTP ${response.status}`);
	}
	return await response.text();
}

async function runManagedNpmCi(stageDir: string): Promise<void> {
	const args = [
		"ci",
		"--ignore-scripts",
		"--min-release-age=0",
		"--omit=dev",
		"--include=optional",
		"--no-fund",
		"--no-audit",
		"--loglevel=error",
		"--progress=false",
	];
	const code = await waitForChildProcess(spawnProcess("npm", args, { cwd: stageDir, stdio: "inherit" }));
	if (code !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${code ?? "unknown"}`);
}

function verifyManagedRelease(releaseDir: string, expectedVersion: string): void {
	const binPath = join(releaseDir, "node_modules", ".bin", process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME);
	const result = spawnProcessSync(binPath, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Could not verify managed Octocode ${expectedVersion}: ${reason}`);
	}
	const installedVersion = result.stdout.trim();
	if (installedVersion !== expectedVersion) {
		throw new Error(`Managed Octocode smoke test returned version ${installedVersion}; expected ${expectedVersion}.`);
	}
}

function activateManagedRelease(managedRoot: string, version: string): void {
	const currentPath = join(managedRoot, "current-version");
	const temporaryPath = join(managedRoot, `current-version.tmp.${process.pid}-${Date.now()}`);
	try {
		writeFileSync(temporaryPath, `${version}\n`);
		renameSync(temporaryPath, currentPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

// Keep the active release and the one running this update, which other open
// sessions likely still use and which allows rolling back by editing current-version.
function pruneManagedReleases(managedRoot: string, activeVersion: string): void {
	const releasesRoot = join(managedRoot, "releases");
	let entries: string[];
	try {
		entries = readdirSync(releasesRoot);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === activeVersion || entry === VERSION || !MANAGED_RELEASE_VERSION_RE.test(entry)) continue;
		try {
			rmSync(join(releasesRoot, entry), { force: true, recursive: true });
		} catch {
			// Files may be in use (e.g. loaded native modules on Windows); retry on the next update.
		}
	}
}

function cleanupManagedStaging(managedRoot: string): void {
	const stagingRoot = join(managedRoot, "staging");
	try {
		for (const entry of readdirSync(stagingRoot)) {
			if (entry.startsWith("update-")) {
				rmSync(join(stagingRoot, entry), { force: true, recursive: true });
			}
		}
	} catch {
		// The staging directory does not exist yet or is not writable.
	}
}

export function cleanupManagedInstall(): void {
	let managedRoot: string | undefined;
	try {
		managedRoot = getActiveManagedInstallRoot();
	} catch {
		return;
	}
	if (!managedRoot) return;

	try {
		const releaseLock = lockfile.lockSync(join(managedRoot, "update"), { realpath: false });
		try {
			cleanupManagedStaging(managedRoot);
		} finally {
			releaseLock();
		}
	} catch {
		// A live update owns the staging directory, or cleanup is unavailable.
	}
}

export async function runManagedSelfUpdate(managedRoot: string, version: string): Promise<void> {
	if (!MANAGED_RELEASE_VERSION_RE.test(version)) {
		throw new Error(`Invalid managed release version: ${version}`);
	}

	let releaseLock: () => Promise<void>;
	try {
		releaseLock = await lockfile.lock(join(managedRoot, "update"), { realpath: false });
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error("Another managed Octocode update is already running.");
		}
		throw error;
	}

	let stageDir: string | undefined;
	try {
		cleanupManagedStaging(managedRoot);
		const installerApiBase = process.env.OCTOCODE_INSTALLER_API_BASE?.trim().replace(/\/+$/, "");
		if (!installerApiBase)
			throw new Error(
				"Managed updates require OCTOCODE_INSTALLER_API_BASE. Install @octocodeai/octocodecode with npm instead.",
			);
		const releaseUrl = `${installerApiBase}/${encodeURIComponent(version)}`;
		const stagingRoot = join(managedRoot, "staging");
		const releasesRoot = join(managedRoot, "releases");
		mkdirSync(releasesRoot, { recursive: true });
		const releaseDir = join(releasesRoot, version);
		if (existsSync(releaseDir)) {
			verifyManagedRelease(releaseDir, version);
			activateManagedRelease(managedRoot, version);
			pruneManagedReleases(managedRoot, version);
			return;
		}

		mkdirSync(stagingRoot, { recursive: true });
		stageDir = mkdtempSync(join(stagingRoot, "update-"));
		const [packageJsonContent, packageLockContent] = await Promise.all([
			fetchInstallerArtifact(`${releaseUrl}/package.json`, "package.json"),
			fetchInstallerArtifact(`${releaseUrl}/package-lock.json`, "package-lock.json"),
		]);
		writeFileSync(join(stageDir, "package.json"), packageJsonContent);
		writeFileSync(join(stageDir, "package-lock.json"), packageLockContent);

		await runManagedNpmCi(stageDir);
		verifyManagedRelease(stageDir, version);
		renameSync(stageDir, releaseDir);
		activateManagedRelease(managedRoot, version);
		pruneManagedReleases(managedRoot, version);
	} finally {
		if (stageDir) rmSync(stageDir, { force: true, recursive: true });
		await releaseLock();
	}
}
