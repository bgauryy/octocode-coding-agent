import type { DbWriterCommand, DbWriterResult } from "./derived.ts";

/** `workerData.worker` of a database writer: its worker checks it before it opens a connection (`worker.ts`). */
export const DB_WRITER_WORKER = "octocode:db-writer";

/** Where the writer's own connection opens: the same locations `sharedDatabase` takes. */
export interface DbWriterLocations {
	file: string;
	mirrorFile: string;
	archiveDir: string;
	privateParent: boolean;
	/** Set for a workspace file: its key and history source (`DatabaseLocations`). */
	workspace?: string;
	historySource?: string;
	/** Set by a host with workspace files on, so the writer opens a split machine file (`DatabaseLocations`). */
	workspaceDir?: string;
}

/**
 * The fields of `locations` a writer thread receives: the cloneable ones it owns. A host's `split` stays behind, so the
 * thread never runs the split (`schema-split.ts`) and its data can be cloned.
 */
export const writerLocations = ({
	file,
	mirrorFile,
	archiveDir,
	privateParent,
	workspace,
	historySource,
	workspaceDir,
}: DbWriterLocations): DbWriterLocations => ({
	file,
	mirrorFile,
	archiveDir,
	privateParent,
	...(workspace === undefined ? {} : { workspace }),
	...(historySource === undefined ? {} : { historySource }),
	...(workspaceDir === undefined ? {} : { workspaceDir }),
});

/**
 * Which file a writer owns: `coordination` (the bookkeeping commands, `derived.ts`) or `mirror` (the transcript mirror's
 * commands, `transcript-mirror.ts`). Each file has its own writer per process, and each writer checkpoints its file.
 */
export type DbWriterRole = "coordination" | "mirror";

export interface DbWriterWorkerData {
	worker: typeof DB_WRITER_WORKER;
	locations: DbWriterLocations;
	role: DbWriterRole;
	/** 0 idle, 1 in an archive pass, 2 stopping; shared so synchronous compression can observe close. */
	stopping: SharedArrayBuffer;
}

/** The data a writer thread starts with: only the locations it owns (`writerLocations`). */
export const writerWorkerData = (
	locations: DbWriterLocations,
	role: DbWriterRole,
	stopping: SharedArrayBuffer,
): DbWriterWorkerData => ({ worker: DB_WRITER_WORKER, locations: writerLocations(locations), role, stopping });

/** One operation: `id` names it in the reply. */
export interface DbWriterRequest {
	id: number;
	command: DbWriterCommand;
}

/** `ready` once the worker's code loaded (before its connection opens); then one reply per request, in request order. */
export type DbWriterMessage =
	| { type: "ready" }
	| { type: "stopped" }
	| { type: "reply"; id: number; ok: true; result: DbWriterResult }
	| { type: "reply"; id: number; ok: false; message: string; busy: boolean };

export function isDbWriterWorkerData(value: unknown): value is DbWriterWorkerData {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { worker?: unknown }).worker === DB_WRITER_WORKER &&
		typeof (value as { locations?: { file?: unknown } }).locations?.file === "string"
	);
}
