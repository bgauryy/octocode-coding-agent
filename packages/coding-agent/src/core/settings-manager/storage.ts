import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getLegacyConfigDirs } from "../../config.ts";
import { atomicWriteFileSync } from "../../utils/atomic-file.ts";
import { lockSyncWithRetry } from "../../utils/file-write-lock.ts";
import { resolvePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { deepMergeObjects, isMergeableObject } from "./merge.ts";

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	/** Whether project settings load and project resources are trusted. Default: false; pass true only after the user or host decided. */
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	/** Read-only loads can leave a missing configuration directory untouched; a returned write is rejected. */
	withLock(
		scope: SettingsScope,
		fn: (current: string | undefined) => string | undefined,
		options?: { readOnly?: boolean },
	): void;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

export type SettingsPaths = Partial<Record<SettingsScope, string>>;

export function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	withLock(
		scope: SettingsScope,
		fn: (current: string | undefined) => string | undefined,
		options: { readOnly?: boolean } = {},
	): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// A writer locks before reading even when this is the first settings file.
			// Startup reads leave missing configuration directories untouched.
			if (!options.readOnly && !existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			if (!options.readOnly || existsSync(path)) {
				release = lockSyncWithRetry(path);
			}
			let current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			if (scope === "global") {
				let inherited: Record<string, unknown> = {};
				for (const legacyDir of getLegacyConfigDirs(dir).reverse()) {
					const legacyFile = join(legacyDir, "settings.json");
					if (!existsSync(legacyFile)) continue;
					const legacy: unknown = JSON.parse(stripBom(readFileSync(legacyFile, "utf-8")));
					if (!isMergeableObject(legacy)) throw new Error(`Invalid settings object: ${legacyFile}`);
					// Resources resolve against their original directory in the resource loader.
					for (const key of [
						"packages",
						"extensions",
						"skills",
						"prompts",
						"themes",
						"sessionDir",
						"deviceId",
						"trackingId",
						"enableAnalytics",
						"defaultProjectTrust",
					])
						delete legacy[key];
					inherited = deepMergeObjects(inherited, legacy);
				}
				if (Object.keys(inherited).length) {
					const native = current !== undefined ? JSON.parse(stripBom(current)) : {};
					if (!isMergeableObject(native)) throw new Error(`Invalid settings object: ${path}`);
					current = JSON.stringify(deepMergeObjects(inherited, native));
				}
			}
			const next = fn(current);
			if (options.readOnly && next !== undefined) {
				throw new Error("Read-only settings transaction cannot write");
			}
			if (next !== undefined) {
				atomicWriteFileSync(path, next);
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(
		scope: SettingsScope,
		fn: (current: string | undefined) => string | undefined,
		options: { readOnly?: boolean } = {},
	): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (options.readOnly && next !== undefined) {
			throw new Error("Read-only settings transaction cannot write");
		}
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}
