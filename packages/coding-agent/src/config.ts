import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir, isBunBinary } from "./install/package-detection.ts";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import { readJsonFile } from "@octocodeai/octocode-common/json";

export { findNodePackageDir, getPackageDir, isBundledNode, isBunBinary } from "./install/package-detection.ts";
export {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
} from "./install/self-update.ts";

// Package Asset Paths (shipped with executable)

/**
 * Where the running code's assets are: `dist/` for code built into `dist/`, even inside a source checkout, so a build
 * never runs with text from a later edit of `src/`; `src/` for code running from source.
 */
export function assetRootName(packageDir: string, runningFile: string, hasSource: boolean): "src" | "dist" {
	return hasSource && !runningFile.startsWith(join(packageDir, "dist") + sep) ? "src" : "dist";
}

function getSourceOrDistDir(): string {
	const packageDir = getPackageDir();
	return join(
		packageDir,
		assetRootName(packageDir, fileURLToPath(import.meta.url), existsSync(join(packageDir, "src"))),
	);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/theme/
 * - For source (src/): src/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	return join(getSourceOrDistDir(), "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For source (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	return join(getSourceOrDistDir(), "core", "export-html");
}

function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/**
 * The native harness folder: `prompts/`, `tools/`, `hooks/`, `agents/` and `skills/`. `native/` next to the executable,
 * or `octocode/native/` of `src/` and `dist/`.
 */
export function getNativeDir(): string {
	if (isBunBinary) return join(getPackageDir(), "native");
	return join(getSourceOrDistDir(), "octocode", "native");
}

/** Built-in agent profiles (researcher, implementer, ...). */
export function getSubagentsDir(): string {
	return join(getNativeDir(), "agents");
}

/** Skills this application ships itself, such as `octocode-context-optimization`. */
export function getNativeSkillsDir(): string {
	return join(getNativeDir(), "skills");
}

/**
 * The public Octocode skill collection (`octocode-research`, `octocode-roast`, ...): `skills/` of the installed
 * `octocode` research CLI package, or `skills/` next to a standalone executable, which `stage-binary` fills from it.
 * Undefined when neither exists, so a build without the research CLI lists no collection.
 */
export function getOctocodeSkillsDir(): string | undefined {
	let dir: string;
	try {
		dir = isBunBinary
			? join(getPackageDir(), "skills")
			: join(dirname(createRequire(getPackageJsonPath()).resolve("octocode/package.json")), "skills");
	} catch {
		return undefined; // The research CLI package is not installed.
	}
	return existsSync(dir) ? dir : undefined;
}

/** The entry file this process was started with, symlinks resolved (an installed `bin` links to the bundle). */
function loadedEntry(): string | undefined {
	const entry = process.argv[1];
	if (!entry) return undefined;
	try {
		return realpathSync(entry);
	} catch {
		return resolve(entry);
	}
}

/**
 * How to start another Octocode process (subagents, forks, workers): the entry this process runs. A process started from
 * the bundle starts the bundle even in a checkout with `src/`, so its children never load a peer's half-saved source
 * edit; a source process, or any other host (tests), uses `src/cli.ts` when it exists.
 */
export function getCliInvocation(): { command: string; prefix: string[] } {
	if (isBunBinary) return { command: process.execPath, prefix: [] };
	const packageDir = getPackageDir();
	const sourceCli = join(packageDir, "src", "cli.ts");
	const bundleCli = join(packageDir, "dist", "bundle", "cli.js");
	const entry = loadedEntry();
	const runsBundle = entry !== undefined && existsSync(bundleCli) && entry === realpathSync(bundleCli);
	if (!runsBundle && existsSync(sourceCli)) {
		return {
			command: process.execPath,
			prefix: ["--import", pathToFileURL(join(packageDir, "scripts", "source-resolver.ts")).href, sourceCli],
		};
	}
	return { command: process.execPath, prefix: [bundleCli] };
}

export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

export type InstallChange = { kind: "updated"; version: string } | { kind: "removed" };

/**
 * Detect that the package this process runs from changed on disk, for example after `octocode update`
 * in another terminal. Code loaded on demand can then be missing or from another version.
 *
 * Checks the package.json read at startup. Resolving it again would walk up past a deleted install
 * and could find an unrelated package.json, such as one in the home directory.
 */
export function detectInstallChange(packageJsonPath = startupPackageJsonPath): InstallChange | undefined {
	// The Bun binary embeds its code, so replacing the executable does not affect this process.
	if (isBunBinary || !packageJsonPath) return undefined;
	let installed: PackageJson;
	try {
		installed = readJsonFile<PackageJson>(packageJsonPath);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installed.version && installed.version !== VERSION
		? { kind: "updated", version: installed.version }
		: undefined;
}

// App Config (from package.json octocodeConfig)

interface PackageJson {
	name?: string;
	version?: string;
	octocodeConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
/** The package.json this process started from, if one existed. */
let startupPackageJsonPath: string | undefined;
try {
	const packageJsonPath = getPackageJsonPath();
	pkg = readJsonFile<PackageJson>(packageJsonPath);
	startupPackageJsonPath = packageJsonPath;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const octocodeConfigName: string | undefined = pkg.octocodeConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@octocodeai/octocode-agent";
export const APP_NAME: string = octocodeConfigName || "octocode";
export const APP_TITLE: string = "Octocode";
export const CONFIG_DIR_NAME: string = pkg.octocodeConfig?.configDir || ".octocode";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., OCTOCODE_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.OCTOCODE_SHARE_VIEWER_URL;
	return baseUrl ? `${baseUrl}#${gistId}` : `https://gist.github.com/${gistId}`;
}

// User Config Paths (~/.octocode/octocodecode/*)

/** Shared root for Octocode Agent configuration and runtime state. */
export function getOctocodeHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const override = env.OCTOCODE_HOME?.trim();
	return override ? resolve(normalizePath(override, { homeDir: home })) : join(home, CONFIG_DIR_NAME, "octocodecode");
}

/** Get the writable Octocode Agent configuration directory. */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return normalizePath(envDir);
	}
	return getOctocodeHome();
}

/** Read-only Pi fallback roots. Explicit homes and SDK directories stay isolated. */
export function getPiConfigDirs(agentDir = getAgentDir()): string[] {
	if (process.env[ENV_AGENT_DIR]?.trim() || process.env.OCTOCODE_HOME?.trim()) return [];
	if (resolve(agentDir) !== resolve(getOctocodeHome())) return [];
	return [join(homedir(), ".pi", "agent"), join(homedir(), ".pi")];
}

/** Credential and model fallbacks only. The Octocode Pi extension stored these files in the older Octocode folders. */
export function providerFallbackDirs(
	agentDir = getAgentDir(),
	home = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (
		env[ENV_AGENT_DIR]?.trim() ||
		env.OCTOCODE_HOME?.trim() ||
		resolve(agentDir) !== resolve(getOctocodeHome(env, home))
	)
		return [];
	return [
		join(home, CONFIG_DIR_NAME, "agent"),
		join(home, CONFIG_DIR_NAME),
		join(home, ".pi", "agent"),
		join(home, ".pi"),
	];
}

export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/**
 * Where Octocode keeps what agents read of skills after optimization: `skills.json` and `skills.txt` for skill
 * descriptions, and `mcp/` for the cache of each MCP server's generated file (`compact` presentation, never reworded).
 * Sessions write it when the discovered skills or a server's catalog change; the `octocode-context-optimization` skill
 * fills in the skill rewrites.
 */
export function getContextOptimizationDir(agentDir = getAgentDir()): string {
	return join(agentDir, "context-optimization");
}

export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
