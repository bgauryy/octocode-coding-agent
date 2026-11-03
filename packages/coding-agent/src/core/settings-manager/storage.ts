import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { lockSyncWithRetry } from "../../../../common/src/file-write-lock.ts";
import { resolvePath } from "../../../../common/src/paths.ts";
import { type InheritedSettings, readInheritedSettings } from "./inherited.ts";

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
	/** Settings read from another product (Pi), merged under the two scopes in memory and never written back. */
	loadInherited?(projectTrusted: boolean): InheritedSettings;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

/** A loaded file that works but holds something Octocode ignores; reported like an error, without failing the load. */
export interface SettingsWarning {
	scope: SettingsScope;
	path?: string;
	message: string;
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
	private readonly cwd: string;
	private readonly agentDir: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.cwd = resolvedCwd;
		this.agentDir = resolvedAgentDir;
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	loadInherited(projectTrusted: boolean): InheritedSettings {
		return readInheritedSettings(this.cwd, this.agentDir, projectTrusted);
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
			const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
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
