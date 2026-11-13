import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@octocodeai/octocode-ai";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import { getFileRevision, normalizePath } from "../../../common/src/paths.ts";
import { stripBom } from "../../../common/src/text.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";
import { isStoredModel } from "./models-store-validation.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

type ModelsFileReload = {
	controller: AbortController;
	promise: Promise<StoredModels>;
	readers: number;
};

type ModelsFileReadState = {
	data: StoredModels;
	revision?: string;
	reload?: ModelsFileReload;
};

// Optimize the common path without retaining an unbounded set of custom paths.
let sharedModelsFileReadState: { path: string; readState: ModelsFileReadState } | undefined;

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;
	private readonly path: string;
	private readonly readState: ModelsFileReadState;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		// The models cache holds no secrets: an existing file keeps its mode.
		this.storage = new FileAuthStorageBackend(this.path, { keepMode: true });
		this.readState = sharedModelsFileReadState?.path === this.path ? sharedModelsFileReadState.readState : { data: {} };
		sharedModelsFileReadState ??= { path: this.path, readState: this.readState };
	}

	private parse(content: string | undefined): StoredModels {
		const data: StoredModels = Object.create(null);
		let parsed: unknown;
		try {
			parsed = content ? JSON.parse(stripBom(content)) : {};
		} catch {
			// This file is a derived catalog cache; a partial write must not prevent the next refresh from replacing it.
			return data;
		}
		if (!isRecord(parsed)) return data;
		for (const [providerId, entry] of Object.entries(parsed)) {
			if (!isRecord(entry) || !Array.isArray(entry.models) || !entry.models.every(isStoredModel)) {
				continue;
			}
			if (
				[entry.lastModified, entry.checkedAt].some((value) => value !== undefined && !Number.isFinite(value)) ||
				(entry.etag !== undefined && typeof entry.etag !== "string")
			) {
				continue;
			}
			data[providerId] = entry as unknown as ModelsStoreEntry;
		}
		return data;
	}

	private updateReadState(readState: ModelsFileReadState, data: StoredModels, revision?: string): void {
		readState.data = data;
		readState.revision = revision;
	}

	private reloadFromStorage(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		return this.storage.withLockAsync(async (content) => {
			const data = this.parse(content);
			this.updateReadState(readState, data, getFileRevision(this.path));
			return { result: data };
		}, options);
	}

	private async readLatest(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		options?.signal?.throwIfAborted();
		const revision = getFileRevision(this.path);
		if (revision !== undefined && revision === readState.revision) return readState.data;
		if (!readState.reload) {
			const controller = new AbortController();
			const reload: ModelsFileReload = {
				controller,
				promise: this.reloadFromStorage(readState, { signal: controller.signal }),
				readers: 0,
			};
			readState.reload = reload;
			void reload.promise.then(
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
			);
		}

		const reload = readState.reload;
		reload.readers++;
		try {
			return await raceWithAbortSignal(reload.promise, options?.signal);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && readState.reload === reload) {
				readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		const entry = (await this.readLatest(this.readState, options))[providerId];
		options?.signal?.throwIfAborted();
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		if (latest) this.updateReadState(this.readState, latest);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		if (latest) this.updateReadState(this.readState, latest);
	}
}
