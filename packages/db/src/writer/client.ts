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

/** The queue is full; nothing was sent, so the caller decides whether the work is needed later. */
export class DbWriterBusyError extends Error {
	readonly code = "DB_WRITER_BUSY";
}

/** The worker stopped before acknowledging: the command may or may not have committed, and nothing reports it either way. */
export class DbWriterUnavailableError extends Error {
	readonly code = "DB_WRITER_UNAVAILABLE";
}

/** The command failed; a stepped mirror save may have committed a partial copy. `busy` means a lock wait expired. */
export class DbWriterCommandError extends Error {
	readonly code = "DB_WRITER_COMMAND";
	readonly busy: boolean;
	constructor(message: string, busy: boolean) {
		super(message);
		this.busy = busy;
	}
}

/**
 * What a rejected `submit` means for its caller: `queue-full` (nothing was sent; try again after `drain`), `unavailable`
 * (the worker stopped before acknowledging), `db-busy` (another connection held the database past the wait) or `failed`
 * (the command ran and failed). Undefined for an error that did not come from a writer.
 */
export type DbWriterErrorKind = "queue-full" | "unavailable" | "db-busy" | "failed";

/** The kind of a writer error: callers branch on this instead of reading the errors' fields. */
export function writerErrorKind(error: unknown): DbWriterErrorKind | undefined {
	if (error instanceof DbWriterBusyError) return "queue-full";
	if (error instanceof DbWriterUnavailableError) return "unavailable";
	if (error instanceof DbWriterCommandError) return error.busy ? "db-busy" : "failed";
	return undefined;
}

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
	private ready = false;
	private inline = false;
	private restarts = 0;
	private sequence = 0;
	private readonly waiting = new Map<number, Waiting>();
	private idle = new Set<() => void>();
	private loading: NodeJS.Timeout | undefined;

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
		live.add(this);
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
		const worker = this.worker;
		this.worker = undefined;
		this.inline = true;
		live.delete(this);
		this.fail(new DbWriterUnavailableError("Database writer closed"));
		void worker?.terminate().catch(() => undefined);
	}

	private runInline(command: DbWriterCommand): Promise<DbWriterResult> {
		try {
			const agent = sharedDatabase(this.locations);
			return Promise.resolve(runWriterCommandWithin(agent, command, INLINE_BUSY_MS));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Promise.reject(new DbWriterCommandError(message, isBusy(error)));
		}
	}

	private start(): Worker | undefined {
		if (this.worker) return this.worker;
		let worker: Worker;
		try {
			const workerData: DbWriterWorkerData = { worker: DB_WRITER_WORKER, locations: this.locations, role: this.role };
			worker = new Worker(this.entry, { workerData });
		} catch {
			this.inline = true;
			return undefined;
		}
		this.worker = worker;
		this.ready = false;
		worker.on("message", (message: DbWriterMessage) => this.receive(message));
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
		if (message.type === "ready") {
			this.ready = true;
			clearTimeout(this.loading);
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
		void worker.terminate().catch(() => undefined);
		if (!this.ready) {
			// The worker's code never loaded (a layout without its file): nothing ran, so run what was sent here, in order.
			this.inline = true;
			const sent = [...this.waiting.values()];
			this.waiting.clear();
			for (const each of sent) this.runInline(each.request.command).then(each.resolve, each.reject);
			this.settle();
			return;
		}
		this.restarts += 1;
		if (this.restarts > MAX_RESTARTS) this.inline = true;
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
 * A process that ends on its own (an empty event loop, not `process.exit`) first waits for unacknowledged commands, at
 * most `EXIT_DRAIN_MS` in all, then stops its writers: their workers are unref'd, so nothing else would wait for them,
 * and a database held by another process must not hold the exit for its busy timeout.
 */
function holdExit(): void {
	if (exitHeld) return;
	exitHeld = true;
	process.on("beforeExit", () => {
		const busy = [...live].filter((writer) => writer.pending > 0);
		if (busy.length === 0) {
			exitDeadline = undefined;
			return;
		}
		exitDeadline ??= Date.now() + EXIT_DRAIN_MS;
		const left = exitDeadline - Date.now();
		if (left <= 0) {
			for (const writer of busy) writer.close();
			return;
		}
		// This timer keeps the loop alive while the writers finish; `beforeExit` comes again when it ends.
		const wait = setTimeout(() => undefined, left);
		void Promise.all(busy.map((writer) => writer.drain(left))).then(() => clearTimeout(wait));
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

/** Closes all process-owned agent databases and their writers (tests, process exit); the next access opens fresh ones. */
export function closeSharedAgentDb(): void {
	for (const writer of writers.values()) writer.close();
	writers.clear();
	closeSharedConnections();
}
