import { parentPort, workerData } from "node:worker_threads";
import { type AgentDb, openDatabase } from "../db.ts";
import { isBusy } from "../sqlite.ts";
import { type DbWriterMessage, type DbWriterRequest, isDbWriterWorkerData, writerLocations } from "./protocol.ts";
import { CheckpointDuty } from "./checkpoint.ts";
import { runWriterCommandWithin } from "./derived.ts";
import { readArchivedAudits } from "../history-reader.ts";

/** Longest one attempt waits inside SQLite for another connection's lock: a stop request lands between attempts. */
const ATTEMPT_BUSY_MS = 250;
/** Longest a command keeps trying while the database is locked, as the connection's usual busy timeout. */
const BUSY_BUDGET_MS = 5_000;
/** The writer's sleep between the transactions of a large save: another connection waiting for the lock gets it then. */
const STEP_PAUSE_MS = 4;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const steps = { pause: () => void Atomics.wait(sleeper, 0, 0, STEP_PAUSE_MS) };

/**
 * The database writer thread: its own connection, one command at a time in arrival order, each one transaction. Waiting
 * for another process's lock happens here, not on the thread that draws the screen, in short attempts so that stopping
 * the worker (process exit) never waits for a whole busy timeout. A connection that cannot open answers every command
 * with that error instead of exiting, so a file that is not a database is reported per write as it was before. The
 * writer checkpoints the file it owns (`role`: the coordination file or the transcript mirror; `checkpoint.ts`).
 */
export function runDbWriterWorker(): void {
	const port = parentPort;
	if (!port || !isDbWriterWorkerData(workerData)) throw new Error("The database writer must run as its worker");
	const { locations, role } = workerData;
	const stopping = new Int32Array(workerData.stopping);
	const assertActive = () => {
		if (Atomics.load(stopping, 0) === 2) throw new Error("Database archive cancelled");
	};
	const post = (message: DbWriterMessage) => port.postMessage(message);
	post({ type: "ready" });
	let agent: AgentDb | undefined;
	// Opened again before each command until it succeeds: a busy or transient failure at open must not fail every later
	// command, and a file that is not a database keeps failing with the same error, reported per write.
	// Only the fields a writer owns: without the host's `split` this thread never runs the split (`schema-split.ts`).
	const open = (): AgentDb => (agent ??= openDatabase(writerLocations(locations)));
	try {
		open();
	} catch {
		// Reported by the first command that needs the connection.
	}
	const checkpoints = new CheckpointDuty(() => (role === "mirror" ? agent?.mirror.db : agent?.db));
	const queue: DbWriterRequest[] = [];
	let running = false;
	const next = () => {
		const request = queue[0];
		running = request !== undefined;
		if (request) void attempt(request, performance.now());
		else checkpoints.idle();
	};
	const attempt = async (request: DbWriterRequest, started: number) => {
		const archive = request.command.kind === "archive-history";
		if (archive && Atomics.compareExchange(stopping, 0, 0, 1) === 2) {
			agent?.close();
			post({ type: "stopped" });
			return;
		}
		try {
			const connection = open();
			const result =
				request.command.kind === "archive-audits"
					? await readArchivedAudits(connection, request.command.query, assertActive)
					: runWriterCommandWithin(connection, request.command, ATTEMPT_BUSY_MS, steps, assertActive);
			post({ type: "reply", id: request.id, ok: true, result });
			checkpoints.ran();
		} catch (error) {
			const busy = isBusy(error);
			if (busy && performance.now() - started < BUSY_BUDGET_MS) {
				setTimeout(() => void attempt(request, started), 0);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			post({ type: "reply", id: request.id, ok: false, message, busy });
		}
		if (archive && Atomics.compareExchange(stopping, 0, 1, 0) === 2) {
			agent?.close();
			post({ type: "stopped" });
			return;
		}
		queue.shift();
		next();
	};
	port.on("message", (request: DbWriterRequest) => {
		checkpoints.busy();
		queue.push(request);
		if (!running) next();
	});
}
