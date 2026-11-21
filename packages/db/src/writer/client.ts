import { Worker } from "node:worker_threads";
import { canonicalPath } from "../../../common/src/canonical-path.ts";
import { closeSharedConnections, sharedDatabase } from "../db.ts";
import { isBusy } from "../sqlite.ts";
import {
	DB_WRITER_WORKER,
	type DbWriterLocations,
	type DbWriterRole,
	type DbWriterMessage,
	type DbWriterRequest,
	type DbWriterWorkerData,
} from "./protocol.ts";
import { type DbWriterCommand, type DbWriterResult, type DerivedCommand, runWriterCommandWithin } from "./derived.ts";
import type { TranscriptCommand, TranscriptResult } from "./transcript-mirror.ts";
import type { HistoryWindows, ArchiveAuditQuery, ArchiveRow } from "../history-archive.ts";
import type { HousekeepingResult } from "../retention.ts";
import { stopDbWriter } from "./stop.ts";
import { INLINE_TRANSCRIPT_LIMIT, transcriptChars } from "./inline-limit.ts";
import {
	DbWriterBusyError,
	DbWriterUnavailableError,
	DbWriterCommandError,
	type DbWriterFallback,
	type DbWriterStats,
} from "./status.ts";

/** Unacknowledged commands one writer holds; a submit past it fails at once rather than queueing without bound. */
export const DB_WRITER_QUEUE_LIMIT = 256;
/** Worker restarts after a crash, per writer; past them the writer runs commands on the calling thread. */
const MAX_RESTARTS = 3;
/** Busy wait of a command run on the calling thread: the screen waits for it, so it stays as short as the old mirror's. */
const INLINE_BUSY_MS = 100;
/** A worker that has not loaded by then never will: its commands run on the calling thread instead. */
const READY_TIMEOUT_MS = 10_000;
/** How long a process that ends on its own waits for unacknowledged commands before it stops its writers. */
const EXIT_DRAIN_MS = 1_500;

export {
	DbWriterBusyError,
	DbWriterUnavailableError,
	DbWriterCommandError,
	writerErrorKind,
	type DbWriterErrorKind,
	type DbWriterFallback,
	type DbWriterStats,
} from "./status.ts";

interface Waiting {
	request: DbWriterRequest;
	resolve: (result: DbWriterResult) => void;
	reject: (error: Error) => void;
}

/**
 * One database writer: a worker thread with its own connection that runs typed commands in submission order, in one
 * transaction or bounded mirror-save steps, and acknowledges after completion. Only data crosses the boundary. One writer per database
 * file: `sharedDbWriter` for the coordination file's bookkeeping (`post`), `sharedMirrorWriter` for the transcript
 * mirror (`submit`); another writer of the same file would only contend for SQLite's single write lock.
 */
export class DbWriter {
	private worker: Worker | undefined;
	private stopping = new Int32Array(new SharedArrayBuffer(4));
	private ready = false;
	private inline = false;
	private restarts = 0;
	private sequence = 0;
	private readonly waiting = new Map<number, Waiting>();
	private idle = new Set<() => void>();
	private loading: NodeJS.Timeout | undefined;
	private fallback: DbWriterFallback | undefined;
	private inlineRuns = 0;
	private inlineMs = 0;
	private inlineMaxMs = 0;
	private inlineRefused = 0;

	private readonly locations: DbWriterLocations;
	private readonly role: DbWriterRole;
	private readonly entry: URL;
	private readonly readyTimeoutMs: number;

	constructor(
		locations: DbWriterLocations,
		options: { entry?: URL; readyTimeoutMs?: number; role?: DbWriterRole } = {},
	) {
		this.locations = locations;
		this.role = options.role ?? "coordination";
		this.entry = options.entry ?? defaultEntry();
		this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
		// A Bun executable embeds only the entries its build names, and this writer's file is not one: there the commands
		// run on the calling thread, as they did before the writer existed.
		this.inline = options.entry === undefined && typeof process.versions.bun === "string";
		if (this.inline) this.fallback = "bun";
		live.add(this);
	}

	/** Its mode, why it runs inline, and the work it ran on the calling thread. */
	stats(): DbWriterStats {
		return {
			role: this.role,
			mode: this.mode,
			...(this.inline && this.fallback ? { fallback: this.fallback } : {}),
			pending: this.waiting.size,
			restarts: this.restarts,
			inlineRuns: this.inlineRuns,
			inlineMs: Math.round(this.inlineMs),
			inlineMaxMs: Math.round(this.inlineMaxMs),
			inlineRefused: this.inlineRefused,
		};
	}

	private goInline(reason: DbWriterFallback): void {
		this.inline = true;
		this.fallback ??= reason;
	}

	/** Commands sent and not yet acknowledged. */
	get pending(): number {
		return this.waiting.size;
	}

	/** `inline` after the worker could not load or crashed too often: commands then run on the calling thread. */
	get mode(): "worker" | "inline" {
		return this.inline ? "inline" : "worker";
	}

	/** Whether `submit` would accept a command now; check before building a large one. */
	canAccept(): boolean {
		return this.inline || this.waiting.size < DB_WRITER_QUEUE_LIMIT;
	}

	/** Resolves after the command's transaction committed (or found nothing to do); rejects with one of the errors above. */
	submit(command: TranscriptCommand): Promise<TranscriptResult> {
		return this.send(command) as Promise<TranscriptResult>;
	}

	/**
	 * A bookkeeping write (`derived.ts`) the caller does not wait for: it runs after every command sent before it, so it
	 * never overtakes one. Resolves after its commit; rejects with one of the errors above.
	 */
	async post(command: DerivedCommand): Promise<void> {
		await this.send(command);
	}
	/** Maintenance requires a worker; the archive is committed before its source rows are deleted. */
	archive(now: number, windows: HistoryWindows): Promise<HousekeepingResult> {
		return this.send({ kind: "archive-history", now, windows }) as Promise<HousekeepingResult>;
	}
	/** Reads and filters history on the worker; at most 500 rows cross back to the caller. */
	archivedAudits(query: ArchiveAuditQuery): Promise<ArchiveRow[]> {
		return this.send({ kind: "archive-audits", query }) as Promise<ArchiveRow[]>;
	}

	private send(command: DbWriterCommand): Promise<DbWriterResult> {
		if (this.inline) return this.runInline(command);
		if (this.waiting.size >= DB_WRITER_QUEUE_LIMIT)
			return Promise.reject(new DbWriterBusyError("Database writer queue is full"));
		const worker = this.start();
		if (!worker) return this.runInline(command);
		const request = { id: ++this.sequence, command };
		return new Promise<DbWriterResult>((resolve, reject) => {
			try {
				// Cloned now: later changes to the caller's objects do not reach the command.
				worker.postMessage(request);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			this.waiting.set(request.id, { request, resolve, reject });
		});
	}

	/** Wait until every sent command is acknowledged, at most `timeoutMs`; false when some are still out. */
	async drain(timeoutMs: number): Promise<boolean> {
		if (this.waiting.size === 0) return true;
		let timer: NodeJS.Timeout | undefined;
		let finished: (() => void) | undefined;
		try {
			return await Promise.race([
				new Promise<boolean>((resolve) => {
					finished = () => resolve(true);
					this.idle.add(finished);
				}),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
					timer.unref();
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (finished) this.idle.delete(finished);
		}
	}

	/** Stop the worker now; unacknowledged commands reject as unavailable. Later commands run on the calling thread. */
	close(): void {
		clearTimeout(this.loading);
		this.loading = undefined;
		const worker = this.worker;
		this.worker = undefined;
		this.goInline("closed");
		live.delete(this);
		this.fail(new DbWriterUnavailableError("Database writer closed"));
		stopDbWriter(worker, this.stopping);
	}

	private runInline(command: DbWriterCommand): Promise<DbWriterResult> {
		if (command.kind === "save-file" || command.kind === "archive-history" || command.kind === "archive-audits")
			return Promise.reject(new DbWriterUnavailableError("Large database maintenance requires the database worker"));
		const chars = transcriptChars(command);
		if (chars > INLINE_TRANSCRIPT_LIMIT) {
			this.inlineRefused += 1;
			return Promise.reject(
				new DbWriterCommandError(
					`A ${Math.ceil(chars / 1024 / 1024)} MB transcript write needs the database worker; it is not run on this thread`,
					false,
				),
			);
		}
		const started = performance.now();
		try {
			const agent = sharedDatabase(this.locations);
			return Promise.resolve(runWriterCommandWithin(agent, command, INLINE_BUSY_MS));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Promise.reject(new DbWriterCommandError(message, isBusy(error)));
		} finally {
			const took = performance.now() - started;
			this.inlineRuns += 1;
			this.inlineMs += took;
			this.inlineMaxMs = Math.max(this.inlineMaxMs, took);
		}
	}

	private start(): Worker | undefined {
		if (this.worker) return this.worker;
		let worker: Worker;
		try {
			this.stopping = new Int32Array(new SharedArrayBuffer(4));
			const workerData: DbWriterWorkerData = {
				worker: DB_WRITER_WORKER,
				locations: this.locations,
				role: this.role,
				stopping: this.stopping.buffer,
			};
			// Its own output streams: the writer prints nothing, and a piped worker adds `error` listeners to this
			// process's stdout and stderr for as long as it lives.
			worker = new Worker(this.entry, { workerData, stdout: true, stderr: true });
		} catch {
			this.goInline("start-failed");
			return undefined;
		}
		this.worker = worker;
		this.ready = false;
		worker.on("message", (message: DbWriterMessage) => {
			if (this.worker === worker) this.receive(message);
		});
		worker.on("error", () => this.lost(worker));
		worker.on("exit", () => this.lost(worker));
		const loading = setTimeout(() => {
			if (!this.ready) this.lost(worker);
		}, this.readyTimeoutMs);
		loading.unref();
		this.loading = loading;
		// Never what keeps a process alive (after the listeners: attaching a message listener refs the worker again). A
		// process that ends on its own waits for what is still unacknowledged, bounded (`holdExit`).
		worker.unref();
		holdExit();
		return worker;
	}

	private receive(message: DbWriterMessage): void {
		if (message.type === "stopped") return;
		if (message.type === "ready") {
			this.ready = true;
			clearTimeout(this.loading);
			this.loading = undefined;
			return;
		}
		const waiting = this.waiting.get(message.id);
		if (!waiting) return;
		this.waiting.delete(message.id);
		if (message.ok) waiting.resolve(message.result);
		else waiting.reject(new DbWriterCommandError(message.message, message.busy));
		this.settle();
	}

	private lost(worker: Worker): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		clearTimeout(this.loading);
		this.loading = undefined;
		stopDbWriter(worker, this.stopping);
		if (!this.ready) {
			// The worker's code never loaded (a layout without its file): nothing ran, so run what was sent here, in order.
			this.goInline("load-failed");
			const sent = [...this.waiting.values()];
			this.waiting.clear();
			for (const each of sent) this.runInline(each.request.command).then(each.resolve, each.reject);
			this.settle();
			return;
		}
		this.restarts += 1;
		if (this.restarts > MAX_RESTARTS) this.goInline("crashed");
		this.fail(new DbWriterUnavailableError("Database writer stopped before acknowledging"));
	}

	private fail(error: Error): void {
		const sent = [...this.waiting.values()];
		this.waiting.clear();
		for (const each of sent) each.reject(error);
		this.settle();
	}

	private settle(): void {
		if (this.waiting.size > 0) return;
		const idle = this.idle;
		this.idle = new Set();
		for (const resolve of idle) resolve();
	}
}

/**
 * From source the worker is `worker-entry.ts`. The Node bundle ships that entry built on its own beside the bundle file
 * (`scripts/build-coding-agent.mjs`), so a writer thread loads the database code, not the whole bundle. A layout without
 * that file fails the worker's load, and the writer runs inline.
 */
function defaultEntry(): URL {
	return new URL(import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./db-writer-worker.js", import.meta.url);
}

const writers = new Map<string, DbWriter>();
/** Every writer not closed, shared or not: the exit wait covers them all. */
const live = new Set<DbWriter>();
let exitHeld = false;
let exitDeadline: number | undefined;

/**
 * Waits for unacknowledged commands of every live writer, at most `EXIT_DRAIN_MS` in all (one budget per exit, however
 * often this is called), then stops the writers still busy: their workers are unref'd, so nothing else would wait for
 * them, and a database held by another process must not hold the exit for its busy timeout. A process that ends with
 * `process.exit` never reaches `beforeExit`: it calls this first.
 */
export async function drainDbWriters(): Promise<void> {
	const busy = [...live].filter((writer) => writer.pending > 0);
	if (busy.length === 0) {
		exitDeadline = undefined;
		return;
	}
	exitDeadline ??= Date.now() + EXIT_DRAIN_MS;
	const left = exitDeadline - Date.now();
	if (left > 0) await Promise.all(busy.map((writer) => writer.drain(left)));
	for (const writer of busy) if (writer.pending > 0) writer.close();
}

/** A process that ends on its own (an empty event loop, not `process.exit`) drains its writers first. */
function holdExit(): void {
	if (exitHeld) return;
	exitHeld = true;
	process.on("beforeExit", () => {
		if (![...live].some((writer) => writer.pending > 0)) {
			exitDeadline = undefined;
			return;
		}
		// This timer keeps the loop alive while the writers finish; `beforeExit` comes again when it ends.
		const wait = setTimeout(() => undefined, EXIT_DRAIN_MS + 1_000);
		void drainDbWriters().finally(() => clearTimeout(wait));
	});
}

/** The process's writer for this coordination file (bookkeeping, `post`), started at its first command. */
export function sharedDbWriter(locations: DbWriterLocations): DbWriter {
	return shared(locations, "coordination", locations.file);
}

/** The process's writer for this transcript mirror file (`submit`), started at its first command. */
export function sharedMirrorWriter(locations: DbWriterLocations): DbWriter {
	return shared(locations, "mirror", locations.mirrorFile);
}

function shared(locations: DbWriterLocations, role: DbWriterRole, file: string): DbWriter {
	const key = canonicalPath(file);
	let writer = writers.get(key);
	if (!writer) {
		writer = new DbWriter(locations, { role });
		writers.set(key, writer);
	}
	return writer;
}

/** The stats of this process's shared writers, in the order they started. */
export function dbWriterStats(): DbWriterStats[] {
	return [...writers.values()].map((writer) => writer.stats());
}

/** Closes all process-owned agent databases and their writers (tests, process exit); the next access opens fresh ones. */
export function closeSharedAgentDb(): void {
	for (const writer of writers.values()) writer.close();
	writers.clear();
	closeSharedConnections();
}
