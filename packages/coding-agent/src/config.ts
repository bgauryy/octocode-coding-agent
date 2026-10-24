import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { getPackageDir, isBunBinary } from "./config/package-detection.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

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
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	return join(getSourceOrDistDir(), "modes", "interactive", "theme");
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

export function getSubagentsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "roles");
	return join(getSourceOrDistDir(), "octocode", "instructions", "roles");
}

/** Public skills come from the installed research CLI; standalone releases stage the same payload. */
export function getBundledSkillsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "skills");
	return join(dirname(createRequire(getPackageJsonPath()).resolve("octocode/package.json")), "skills");
}

export function getCliInvocation(): { command: string; prefix: string[] } {
	if (isBunBinary) return { command: process.execPath, prefix: [] };
	const packageDir = getPackageDir();
	const sourceCli = join(packageDir, "src", "cli.ts");
	if (existsSync(sourceCli)) {
		return {
			command: process.execPath,
			prefix: [
				"--import",
				pathToFileURL(join(packageDir, "src", "experimental", "source-resolver.ts")).href,
				sourceCli,
			],
		};
	}
	return { command: process.execPath, prefix: [join(packageDir, "dist", "bundle", "cli.js")] };
}

export function getResearchCliInvocation(kind: "research" | "native"): { command: string; prefix: string[] } {
	const require = createRequire(getPackageJsonPath());
	let entry: string;
	if (kind === "native") {
		entry = require.resolve("@octocodeai/octocode-native/bin/octocode.cjs");
	} else {
		const manifestPath = require.resolve("octocode/package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.octocode;
		if (!bin) throw new Error("The installed octocode research package has no CLI entry");
		entry = resolve(dirname(manifestPath), bin);
	}
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
		installed = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
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
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
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

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
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
