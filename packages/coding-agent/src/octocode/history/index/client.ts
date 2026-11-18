import { Worker } from "node:worker_threads";
import { agentDbPath, archiveIndexDbPath } from "../../../storage/state-paths.ts";
import { onSegmentWritten } from "../archive.ts";
import type { Scored } from "../rank/score.ts";
import type { Filtered, RankFile } from "../rank/scan.ts";
import { IndexCancelled, type IndexRequest, IndexService } from "./service.ts";

/**
 * The archive index as the main thread sees it: one worker per process (started at first use, stopped after
 * `IDLE_MS` without requests) runs every ranking and sync with its own connection to the index file, so neither
 * tokenizing nor SQLite work holds the main thread. A worker that cannot load leaves the process on an `IndexService`
 * on this thread, which yields between batches.
 */

const IDLE_MS = 60_000;

type Pending = { resolve(scored: Scored | undefined): void; reject(error: Error): void };

interface Running {
	file: string;
	worker?: Worker;
	inline?: IndexService;
	ready: boolean;
	pending: Map<number, Pending & { request: IndexRequest }>;
}

let running: Running | undefined;
let nextId = 1;
/** Why this process ranks on its own thread: the worker's load error, kept so every ranking can say so. */
let loadFailure: string | undefined;

/** Set when the worker could not load and the index runs on this thread instead (slower, same results). */
export function archiveIndexFallback(): string | undefined {
	return loadFailure;
}
let idle: NodeJS.Timeout | undefined;

/** From source the worker is `worker-entry.ts`; the Node bundle ships it as `archive-index-worker.js` beside itself. */
const entry = () =>
	new URL(import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./archive-index-worker.js", import.meta.url);

function settleAll(state: Running, error: Error): void {
	for (const { reject } of state.pending.values()) reject(error);
	state.pending.clear();
}

function start(file: string): Running {
	const state: Running = { file, ready: false, pending: new Map() };
	const worker = new Worker(entry(), { workerData: { file } });
	worker.unref();
	state.worker = worker;
	worker.on(
		"message",
		(message: { ready: true } | { id: number; ok: boolean; scored?: Scored; cancelled?: boolean; error?: string }) => {
			if ("ready" in message) {
				state.ready = true;
				loadFailure = undefined;
				return;
			}
			const pending = state.pending.get(message.id);
			if (!pending) return;
			state.pending.delete(message.id);
			if (message.ok) pending.resolve(message.scored);
			else pending.reject(message.cancelled ? new IndexCancelled() : new Error(message.error));
			scheduleIdle();
		},
	);
	worker.on("error", (error) => {
		if (running === state) running = undefined;
		if (state.ready) {
			settleAll(state, error);
			return;
		}
		// The worker could not load (a layout without its file): this process runs the index on its own thread.
		loadFailure = error.message;
		const inline: Running = { file, ready: true, inline: new IndexService(file, { yields: true }), pending: new Map() };
		running ??= inline;
		for (const [, { request, resolve, reject }] of state.pending) void send(running, request).then(resolve, reject);
		state.pending.clear();
	});
	worker.on("exit", () => {
		if (running === state) running = undefined;
		settleAll(state, new Error("The archive index worker stopped."));
	});
	return state;
}

function send(state: Running, request: IndexRequest): Promise<Scored | undefined> {
	if (state.inline) return state.inline.run(request);
	const id = nextId++;
	return new Promise((resolve, reject) => {
		state.pending.set(id, { request, resolve, reject });
		state.worker!.postMessage({ id, request });
	});
}

function scheduleIdle(): void {
	clearTimeout(idle);
	idle = setTimeout(() => {
		if (running?.worker && running.pending.size === 0) void closeArchiveIndex();
	}, IDLE_MS);
	idle.unref();
}

function service(env: NodeJS.ProcessEnv): Running {
	const file = archiveIndexDbPath(agentDbPath(env));
	if (running && running.file !== file) void closeArchiveIndex();
	running ??= start(file);
	clearTimeout(idle);
	return running;
}

async function request(
	build: (cancel: SharedArrayBuffer) => IndexRequest,
	signal: AbortSignal | undefined,
	env: NodeJS.ProcessEnv,
): Promise<Scored | undefined> {
	signal?.throwIfAborted();
	const cancel = new SharedArrayBuffer(4);
	const onAbort = () => Atomics.store(new Int32Array(cancel), 0, 1);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await send(service(env), build(cancel));
	} catch (error) {
		if (error instanceof IndexCancelled && signal?.aborted) throw signal.reason;
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		scheduleIdle();
	}
}

/** The first pass and scores of a keyword ranking of `files`, from the index and a scan of what it lacks. */
export async function rankArchive(
	files: readonly RankFile[],
	keywords: string,
	filtered: Filtered | undefined,
	signal?: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Scored> {
	const scored = await request(
		(cancel) => ({
			type: "rank",
			files: files.map(({ file, label }) => ({ file, label })),
			keywords,
			...(filtered ? { filtered: [...filtered].map(([at, lines]) => [at, [...lines]] as [number, number[]]) } : {}),
			cancel,
		}),
		signal,
		env,
	);
	return scored!;
}

/** Indexes what changed among `paths` in the background; `prune` also drops files gone from disk. */
export function syncArchiveIndex(
	paths: readonly string[],
	options: { prune?: boolean; signal?: AbortSignal } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	return request(
		(cancel) => ({ type: "sync", paths: [...paths], ...(options.prune ? { prune: true } : {}), cancel }),
		options.signal,
		env,
	).then(() => undefined);
}

// A segment written while the index is open is indexed at once; otherwise the next query or startup sync indexes it.
onSegmentWritten((file) => {
	if (running) void syncArchiveIndex([file]).catch(() => undefined);
});

/** Stops the worker (or closes the index on this thread) once its queued requests are done. */
export async function closeArchiveIndex(): Promise<void> {
	clearTimeout(idle);
	const state = running;
	running = undefined;
	if (!state) return;
	if (state.inline) return state.inline.close();
	const worker = state.worker!;
	const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	// Held until it exits: an unref'd worker would let the process end before the index is closed.
	worker.ref();
	worker.postMessage({ close: true });
	await exited;
}
