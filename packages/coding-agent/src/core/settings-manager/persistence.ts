import { retentionProblems } from "../../storage/retention.ts";
import { stripBom } from "../../../../common/src/text.ts";
import type { Settings } from "../settings-schema.ts";
import { ignoredBuiltinSwitches } from "../features/builtin-ids.ts";
import { describeIgnoredKeys, ignoredSettingsKeys } from "./ignored-keys.ts";
import { settingsObject } from "./load.ts";
import { effectiveSettings } from "./merge.ts";
import type { SettingsState } from "./state.ts";
import { type SettingsScope, toSettingsError } from "./storage.ts";
import { settingsWritesDeferred } from "./storage-deferred.ts";

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

	recordError(scope: SettingsScope, error: unknown): Error {
		const recorded = toSettingsError(scope, error, this.state.settingsPaths[scope]);
		this.state.errors.push(recorded);
		return recorded.error;
	}

	/**
	 * Queue one warning naming every key of freshly loaded `settings` that Octocode does not read, one for each `extensions`
	 * entry that tries to switch off an always-on built-in, and one for each invalid `retention` value (a project file's
	 * `retention` is ignored: retention is global).
	 */
	recordIgnoredKeys(scope: SettingsScope, settings: Settings): void {
		const path = this.state.settingsPaths[scope];
		const ignored = describeIgnoredKeys(ignoredSettingsKeys(settings), scope);
		const messages = [
			...(ignored ? [ignored] : []),
			...ignoredBuiltinSwitches(settings.extensions ?? []),
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

	/**
	 * Write the snapshot's changed fields into the scope's file. A storage that can defer its commit decides the content
	 * now (readers in this process see it at once) and writes off the event loop; later changes join a write that has not
	 * started. Otherwise the write runs on this queue as a synchronous transaction.
	 */
	private enqueueWrite(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): Promise<Error | undefined> {
		const merge = (current: string | undefined) =>
			mergeScopedSettings(current, snapshotSettings, modifiedFields, modifiedNestedFields);
		const storage = this.state.storage;
		if (storage.withLockDeferred && settingsWritesDeferred()) {
			let written: Promise<void>;
			try {
				if (scope === "project") this.assertProjectTrustedForWrite();
				written = storage.withLockDeferred(scope, merge);
			} catch (error) {
				return Promise.resolve(this.recordError(scope, error));
			}
			const settled = written.then(
				() => {
					this.clearModifiedScope(scope);
					return undefined;
				},
				(error: unknown) => this.recordError(scope, error),
			);
			this.writeQueue = Promise.all([this.writeQueue, settled]).then(() => undefined);
			return settled;
		}
		const written = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				storage.withLock(scope, merge);
				this.clearModifiedScope(scope);
				return undefined;
			})
			.catch((error: unknown) => this.recordError(scope, error));
		this.writeQueue = written.then(() => undefined);
		return written;
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	/** Resolves with this attempt's error, if any; ordinary setters still report it through diagnostics. */
	save(): Promise<Error | undefined> {
		const state = this.state;
		state.settings = effectiveSettings(state);

		if (state.globalSettingsLoadError) {
			return Promise.resolve(state.globalSettingsLoadError);
		}

		const snapshotGlobalSettings = structuredClone(state.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		return this.enqueueWrite("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
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
		void this.enqueueWrite("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
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

/** `current` file content with the changed fields of `snapshot` merged in: other fields stay as another process wrote them. */
function mergeScopedSettings(
	current: string | undefined,
	snapshotSettings: Settings,
	modifiedFields: Set<keyof Settings>,
	modifiedNestedFields: Map<keyof Settings, Set<string>>,
): string {
	const currentFileSettings =
		current !== undefined ? settingsObject(JSON.parse(stripBom(current)) as Record<string, unknown>) : {};
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
}
