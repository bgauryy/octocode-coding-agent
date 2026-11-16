import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { lockSyncWithRetry } from "@octocodeai/octocode-common/file-write-lock";
import { resolvePath } from "@octocodeai/octocode-common/paths";
import { type InheritedSettings, readInheritedSettings } from "./inherited.ts";
import { noteSettingsWritten, readSettingsFile, writeSettingsFileDeferred } from "./storage-deferred.ts";

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	/** Whether project settings load and project resources are trusted. Default: false; pass true only after the user or host decided. */
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	/**
	 * Read-only loads can leave a missing configuration directory untouched and take no lock; a returned write is
	 * rejected.
	 */
	withLock(
		scope: SettingsScope,
		fn: (current: string | undefined) => string | undefined,
		options?: { readOnly?: boolean },
	): void;
	/**
	 * `withLock` for a write whose file commit runs off the event loop: `fn` runs now, readers in this process see its
	 * result at once, and the promise settles once the file holds it. Absent, writes use `withLock`.
	 */
	withLockDeferred?(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void>;
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
	private readonly globalSettingsPath: string;
	private readonly projectSettingsPath: string;
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

	/** The global and project settings files this storage reads and writes. */
	get paths(): Required<SettingsPaths> {
		return { global: this.globalSettingsPath, project: this.projectSettingsPath };
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
			// Every write replaces the file by an atomic rename, so a reader sees the old or the new file whole: only a
			// writer locks, to read and merge without losing a concurrent update. Siblings starting together read at once.
			if (!options.readOnly) {
				release = lockSyncWithRetry(path);
			}
			// A write of this process still on its way to the file is what the file is about to hold.
			const current = readSettingsFile(path);
			const next = fn(current);
			if (options.readOnly && next !== undefined) {
				throw new Error("Read-only settings transaction cannot write");
			}
			if (next !== undefined) {
				atomicWriteFileSync(path, next);
				noteSettingsWritten(path, next);
			}
		} finally {
			if (release) {
				release();
			}
		}
	}

	withLockDeferred(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void> {
		return writeSettingsFileDeferred(scope === "global" ? this.globalSettingsPath : this.projectSettingsPath, fn);
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
