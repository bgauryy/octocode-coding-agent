import type { TranscriptCommand, TranscriptResult } from "./transcript-mirror.ts";

/** `workerData.worker` of a database writer: its worker checks it before it opens a connection (`worker.ts`). */
export const DB_WRITER_WORKER = "octocode:db-writer";

/** Where the writer's own connection opens: the same locations `sharedDatabase` takes. */
export interface DbWriterLocations {
	file: string;
	archiveDir: string;
	privateParent: boolean;
}

export interface DbWriterWorkerData {
	worker: typeof DB_WRITER_WORKER;
	locations: DbWriterLocations;
}

/** One operation: `id` names it in the reply. */
export interface DbWriterRequest {
	id: number;
	command: TranscriptCommand;
}

/** `ready` once the worker's code loaded (before its connection opens); then one reply per request, in request order. */
export type DbWriterMessage =
	| { type: "ready" }
	| { type: "reply"; id: number; ok: true; result: TranscriptResult }
	| { type: "reply"; id: number; ok: false; message: string; busy: boolean };

export function isDbWriterWorkerData(value: unknown): value is DbWriterWorkerData {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { worker?: unknown }).worker === DB_WRITER_WORKER &&
		typeof (value as { locations?: { file?: unknown } }).locations?.file === "string"
	);
}
