import { getFileRevision } from "@octocodeai/octocode-common/paths";
import { watchFileChanges } from "@octocodeai/octocode-common/watch-file";
import type { ModelsProject } from "../model-config/project.ts";
import { projectModelsPaths } from "../model-config/project.ts";
import { providerSourceGate } from "../provider-sources/gate.ts";
import type { RuntimeCredentials } from "../runtime-credentials.ts";

/** Quiet time after the last file event before a reload runs: a user edits models.json and auth.json together. */
const DEBOUNCE_MS = 150;

export interface LiveReloadOptions {
	/** models.json path; undefined when the runtime has none. */
	readonly modelsPath: string | undefined;
	/** Its models.json files (Octocode's, and Pi's when that source is on) are followed too, also while missing. */
	readonly project?: ModelsProject;
	readonly credentials: RuntimeCredentials;
	/** The full local reload (models.json, providers, availability). */
	readonly reload: () => Promise<unknown>;
	/** Called with the failure of a reload; the next change retries. */
	readonly onError: (error: unknown) => void;
}

/** The models.json files a runtime follows: its own, and the project's (Pi's too while that source is on). */
export function followedModelsFiles(modelsPath: string | undefined, project: ModelsProject | undefined): string[] {
	const projectFiles = project ? projectModelsPaths(project.cwd, providerSourceGate.isEnabled("pi")) : [];
	return modelsPath ? [modelsPath, ...projectFiles] : projectFiles;
}

/**
 * Follows models.json and auth.json while the runtime lives. Either file changing, alone or both together,
 * schedules one full reload: the debounce merges a burst, and a change during a running reload queues exactly one
 * more, so the last state on disk is always the one loaded. Only revisions are compared; nothing is read here.
 */
export class RuntimeLiveReload {
	private readonly options: LiveReloadOptions;
	private readonly stops: Array<() => void> = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private dirty = false;
	private disposed = false;

	constructor(options: LiveReloadOptions) {
		this.options = options;
		this.stops.push(options.credentials.watch(() => this.schedule()));
		for (const file of followedModelsFiles(options.modelsPath, options.project)) this.follow(file);
	}

	/** Schedules a reload when `file`'s revision changes. */
	private follow(file: string): void {
		let seen = getFileRevision(file);
		this.stops.push(
			watchFileChanges(file, () => {
				const revision = getFileRevision(file);
				if (revision === seen) return;
				seen = revision;
				this.schedule();
			}),
		);
	}

	/** Stop both watchers and any pending reload. A reload already running finishes. Repeated calls do nothing. */
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		for (const stop of this.stops.splice(0)) stop();
	}

	private schedule(): void {
		if (this.disposed) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
		this.timer.unref();
	}

	private async run(): Promise<void> {
		if (this.disposed) return;
		if (this.running) {
			this.dirty = true;
			return;
		}
		this.running = true;
		try {
			do {
				this.dirty = false;
				try {
					await this.options.reload();
				} catch (error) {
					this.options.onError(error);
				}
			} while (this.dirty && !this.disposed);
		} finally {
			this.running = false;
		}
	}
}
