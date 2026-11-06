import { retentionProblems } from "../../config/retention.ts";
import { stripBom } from "../../../../common/src/text.ts";
import type { Settings } from "../settings-schema.ts";
import { describeIgnoredKeys, ignoredSettingsKeys } from "./ignored-keys.ts";
import { migrateSettings } from "./load.ts";
import { effectiveSettings } from "./merge.ts";
import type { SettingsState } from "./state.ts";
import { type SettingsScope, toSettingsError } from "./storage.ts";

/**
 * Writes settings changes back to storage. Tracks which fields changed during the session, so a write merges only
 * those fields into the file's current content, and serializes writes through one queue.
 */
export class SettingsPersistence {
	private readonly state: SettingsState;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(state: SettingsState) {
		this.state = state;
	}

	/** Settles after every write queued so far. */
	get pendingWrites(): Promise<void> {
		return this.writeQueue;
	}

	/** Mark a global field as modified during this session */
	markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	assertProjectTrustedForWrite(): void {
		if (!this.state.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	recordError(scope: SettingsScope, error: unknown): void {
		this.state.errors.push(toSettingsError(scope, error, this.state.settingsPaths[scope]));
	}

	/**
	 * Queue one warning naming every key of freshly loaded `settings` that Octocode does not read, and one for each invalid
	 * `retention` value (a project file's `retention` is ignored: retention is global).
	 */
	recordIgnoredKeys(scope: SettingsScope, settings: Settings): void {
		const path = this.state.settingsPaths[scope];
		const ignored = describeIgnoredKeys(ignoredSettingsKeys(settings));
		const messages = [
			...(ignored ? [ignored] : []),
			...(scope === "project" && settings.retention !== undefined
				? ['Setting "retention" is global only; a project settings file cannot set it, so it does nothing.']
				: retentionProblems(settings.retention)),
		];
		for (const message of messages) this.state.warnings.push({ scope, ...(path ? { path } : {}), message });
	}

	clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.state.storage.withLock(scope, (current) => {
			const currentFileSettings =
				current !== undefined ? migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>) : {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	save(): void {
		const state = this.state;
		state.settings = effectiveSettings(state);

		if (state.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(state.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		const state = this.state;
		this.assertProjectTrustedForWrite();
		state.projectSettings = structuredClone(settings);
		state.settings = effectiveSettings(state);

		if (state.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(state.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	/** `nestedKey` writes only that key of an object field, keeping keys another process wrote meanwhile. */
	updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void, nestedKey?: string): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.state.projectSettings);
		update(projectSettings);
		this.markProjectModified(field, nestedKey);
		this.saveProjectSettings(projectSettings);
	}
}
