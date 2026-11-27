import type { MutableModels } from "@octocodeai/octocode-ai";
import { getFileRevision } from "@octocodeai/octocode-common/paths";
import type { ModelsProject } from "../model-config/project.ts";
import { followedModelsFiles } from "./live-reload.ts";

/**
 * How long a full refresh answers an interactive one (an open of /model) while nothing it read changed. Remote catalogs
 * keep their own, longer interval; this bounds what no watcher follows: Pi's and the legacy global models.json files.
 */
export const REFRESH_REUSE_MS = 60_000;

/** A full refresh that settled cleanly: when it started, what it read, and the providers that had auth after it. */
export interface SettledRefresh {
	readonly at: number;
	readonly inputs: string;
	configured: ReadonlySet<string>;
}

/** The cheap facts a full refresh read: the followed models.json files' revisions and the project's trust. */
export function refreshInputs(modelsPath: string | undefined, project: ModelsProject | undefined): string {
	const files = followedModelsFiles(modelsPath, project).map((file) => [file, getFileRevision(file) ?? null]);
	return JSON.stringify([project?.isTrusted() ?? null, files]);
}

/** The last settled full refresh of each runtime, by its models collection; any other refresh forgets it. */
const settled = new WeakMap<MutableModels, SettledRefresh>();

export function rememberRefresh(models: MutableModels, refresh: SettledRefresh): void {
	settled.set(models, refresh);
}

export function forgetRefresh(models: MutableModels): void {
	settled.delete(models);
}

/** The settled refresh that may answer one starting at `now` with these inputs; undefined when it is too old or stale. */
export function reusableRefresh(models: MutableModels, inputs: string, now: number): SettledRefresh | undefined {
	const last = settled.get(models);
	return last && now - last.at < REFRESH_REUSE_MS && last.inputs === inputs ? last : undefined;
}
