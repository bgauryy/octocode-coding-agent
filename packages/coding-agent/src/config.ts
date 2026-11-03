import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, isBunBinary } from "./config/package-detection.ts";
import { normalizePath } from "../../common/src/paths.ts";
import { readJsonFile } from "../../common/src/json.ts";

export { findNodePackageDir, getPackageDir, isBundledNode, isBunBinary } from "./config/package-detection.ts";
export {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
} from "./config/self-update.ts";

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/** `src/` when running from a source checkout, otherwise `dist/`. */
function getSourceOrDistDir(): string {
	const packageDir = getPackageDir();
	return join(packageDir, existsSync(join(packageDir, "src")) ? "src" : "dist");
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

/** Get path to package.json */
function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** The Markdown prompt files under `octocode/instructions/` (policy, lean, subagent, system, workflows and roles): `instructions/` next to the executable, or in `octocode/` of `src/` and `dist/`. */
export function getInstructionsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "instructions");
	return join(getSourceOrDistDir(), "octocode", "instructions");
}

export function getSubagentsDir(): string {
	return join(getInstructionsDir(), "roles");
}

/** Skills this application ships itself, such as `octocode-context-optimization`: `native-skills/` next to the executable, or in `octocode/` of `src/` and `dist/`. */
export function getNativeSkillsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "native-skills");
	return join(getSourceOrDistDir(), "octocode", "native-skills");
}

/** Public skills come from the installed research CLI; standalone releases stage the same payload. */
export function getBundledSkillsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "skills");
	return join(dirname(createRequire(getPackageJsonPath()).resolve("octocode/package.json")), "skills");
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

/** The installed platform binary of `@octocodeai/octocode-native`, through the package's own resolver (it ships no `bin`). */
export function getNativeBinaryPath(): string {
	const resolver = createRequire(getPackageJsonPath())("@octocodeai/octocode-native/bin/resolve-binary.cjs") as {
		resolveNativeBinaryPath(): string;
	};
	return resolver.resolveNativeBinaryPath();
}

export function getResearchCliInvocation(kind: "research" | "native"): { command: string; prefix: string[] } {
	if (kind === "native") {
		const binary = getNativeBinaryPath();
		if (!existsSync(binary)) throw new Error(`Octocode native CLI is missing: ${binary}`);
		return { command: binary, prefix: [] };
	}
	const manifestPath = createRequire(getPackageJsonPath()).resolve("octocode/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		bin?: string | Record<string, string>;
	};
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.octocode;
	if (!bin) throw new Error("The installed octocode research package has no CLI entry");
	const entry = resolve(dirname(manifestPath), bin);
	if (!existsSync(entry)) throw new Error(`Octocode ${kind} CLI is missing: ${entry}`);
	return { command: isBunBinary ? "node" : process.execPath, prefix: [entry] };
}

/** Get path to CHANGELOG.md */
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
		installed = readJsonFile(packageJsonPath) as PackageJson;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installed.version && installed.version !== VERSION
		? { kind: "updated", version: installed.version }
		: undefined;
}

// =============================================================================
// App Config (from package.json octocodeConfig)
// =============================================================================

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
	pkg = readJsonFile(packageJsonPath) as PackageJson;
	startupPackageJsonPath = packageJsonPath;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const octocodeConfigName: string | undefined = pkg.octocodeConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@octocodeai/octocodecode";
export const APP_NAME: string = octocodeConfigName || "octocode";
export const APP_TITLE: string = "Octocode";
export const CONFIG_DIR_NAME: string = pkg.octocodeConfig?.configDir || ".octocode";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., OCTOCODE_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

/** Get the share viewer URL for a gist ID. */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.OCTOCODE_SHARE_VIEWER_URL;
	return baseUrl ? `${baseUrl}#${gistId}` : `https://gist.github.com/${gistId}`;
}

// =============================================================================
// User Config Paths (~/.octocode/octocodecode/*)
// =============================================================================

/** Shared root for Octocode Code configuration and runtime state. */
export function getOctocodeHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const override = env.OCTOCODE_HOME?.trim();
	return override ? resolve(normalizePath(override, { homeDir: home })) : join(home, CONFIG_DIR_NAME, "octocodecode");
}

/** Get the writable Octocode Code configuration directory. */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return normalizePath(envDir);
	}
	return getOctocodeHome();
}

/** Read-only Pi fallback roots. Explicit homes and SDK directories stay isolated. */
export function getLegacyConfigDirs(agentDir = getAgentDir()): string[] {
	if (process.env[ENV_AGENT_DIR]?.trim() || process.env.OCTOCODE_HOME?.trim()) return [];
	if (resolve(agentDir) !== resolve(getOctocodeHome())) return [];
	return [join(homedir(), ".pi", "agent"), join(homedir(), ".pi")];
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/**
 * Where Octocode keeps what agents read of skills and MCP servers after optimization: `skills.json` and `skills.txt` for
 * skill descriptions, `mcp/` for each MCP server's generated file. Sessions write it when the discovered skills or a
 * server's catalog change; the `octocode-context-optimization` skill fills in the rewrites.
 */
export function getContextOptimizationDir(agentDir = getAgentDir()): string {
	return join(agentDir, "context-optimization");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
