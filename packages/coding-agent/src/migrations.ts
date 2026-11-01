/**
 * Historical conversions invoked explicitly by `octocode migrate`.
 */

import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { atomicWriteFileSync } from "../../common/src/atomic-file.ts";
import { join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { FileAuthStorageBackend } from "./core/auth-storage/backends.ts";
import { getDefaultSessionDirPath } from "./core/session-manager/storage.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { stripBom } from "../../common/src/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { readJsonFile } from "../../common/src/json.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/bgauryy/octocodecode/blob/main/packages/coding-agent/docs/configuration.md#historical-migrations";
const EXTENSIONS_DOC_URL = "https://github.com/bgauryy/octocodecode/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy credentials, preserving providers already present in auth.json. auth.json is merged under the lock
 * every running session takes to write it, and written atomically, so a concurrent login or token refresh is neither
 * lost nor torn; while another process holds the lock, the migration fails before retiring any source.
 *
 * @returns Array of provider names that were migrated
 */
function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	/** Legacy credentials by provider, oauth.json first; each is migrated only where auth.json has no entry. */
	const legacy: [string, Record<string, unknown>][] = [];
	let oauthRead = false;
	let settingsWithKeys: Record<string, unknown> | undefined;

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = readJsonFile<Record<string, unknown>>(oauthPath);
			for (const [provider, cred] of Object.entries(oauth)) {
				if (typeof cred !== "object" || cred === null) continue;
				legacy.push([provider, { type: "oauth", ...cred }]);
			}
			oauthRead = true;
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (typeof key === "string") legacy.push([provider, { type: "api_key", key }]);
				}
				settingsWithKeys = settings;
			}
		} catch {
			// Skip on error
		}
	}

	const providers: string[] = [];
	if (legacy.length > 0) {
		new FileAuthStorageBackend(authPath).withLock((current) => {
			const migrated: unknown = current?.trim() ? JSON.parse(stripBom(current)) : {};
			if (typeof migrated !== "object" || migrated === null || Array.isArray(migrated)) {
				throw new Error(`Cannot migrate credentials: ${authPath} must contain an object.`);
			}
			const merged = migrated as Record<string, unknown>;
			for (const [provider, credential] of legacy) {
				if (Object.hasOwn(merged, provider)) continue;
				merged[provider] = credential;
				providers.push(provider);
			}
			return { result: undefined, next: providers.length > 0 ? JSON.stringify(merged, null, 2) : undefined };
		});
	}
	// Retire source credentials only after the destination has been saved successfully.
	if (oauthRead && !existsSync(`${oauthPath}.migrated`)) renameSync(oauthPath, `${oauthPath}.migrated`);
	if (settingsWithKeys) {
		delete settingsWithKeys.apiKeys;
		atomicWriteFileSync(settingsPath, JSON.stringify(settingsWithKeys, null, 2));
	}

	return providers;
}

/**
 * Migrate sessions from ~/.octocode/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.octocode/agent/ instead of
 * ~/.octocode/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 */
function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// The folder the session listing reads for this cwd (its own encoding, on the resolved path).
			const correctDir = getDefaultSessionDirPath(cwd, agentDir);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(chalk.yellow(`Warning: Could not migrate ${label} commands/ to prompts/: ${errorMessage(err)}`));
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = readJsonFile(configPath) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		atomicWriteFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by Octocode, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print migration warnings without blocking scripted runs on terminal input.
 */
export function showDeprecationWarnings(warnings: string[]): void {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log();
}

/**
 * Run historical conversions only when explicitly requested.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
