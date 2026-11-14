import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeSharedAgentDb,
	DB_WRITER_QUEUE_LIMIT,
	DbWriter,
	DbWriterBusyError,
	DbWriterCommandError,
	DbWriterUnavailableError,
	type FileStamp,
	openDatabase,
	type TranscriptCommand,
	transcripts,
	writerErrorKind,
	type DbWriterLocations,
} from "../src/api.ts";
import { getFileStamp } from "../../common/src/paths.ts";
import { tmp } from "./helpers.ts";

let dir: string;
let locations: DbWriterLocations;
let writers: DbWriter[];
beforeEach(() => {
	dir = tmp();
	locations = {
		file: path.join(dir, "writer.db"),
		mirrorFile: path.join(dir, "writer.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
	writers = [];
});
afterEach(() => {
	for (const writer of writers) writer.close();
	closeSharedAgentDb();
});

/** Another process holding the write lock of `file` (the coordination file) for `ms`; resolves once it holds it. */
async function holdLock(ms: number, file = locations.file) {
	const holder = spawn(
		process.execPath,
		[
			"-e",
			`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(file)});
			 db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); setTimeout(() => db.exec("COMMIT"), ${ms});`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
	return {
		stop: () => {
			if (holder.exitCode === null && holder.signalCode === null) holder.kill();
		},
		released: () =>
			holder.exitCode !== null || holder.signalCode !== null
				? Promise.resolve()
				: new Promise<void>((resolve) => holder.once("exit", () => resolve())),
	};
}

const writer = (entry?: URL) => {
	const made = new DbWriter(locations, { entry });
	writers.push(made);
	return made;
};
const workspace = { id: "ws-writer", root: "/r/writer", name: "writer", binding: "1:1" };
const header = (id: string) => ({
	type: "session",
	version: 3,
	id,
	timestamp: new Date(0).toISOString(),
	cwd: "/r/writer",
});
const entry = (id: string, parentId: string | null) => ({ type: "custom", id, parentId, customType: "probe" });
/** A record as the session writer sends it: its line, serialized once. */
const asRow = (record: ReturnType<typeof entry>) => ({
	id: record.id,
	parentId: record.parentId,
	type: record.type,
	json: JSON.stringify(record),
});

/** A session file with its header and `count` entries; its stamp is taken after the write, as the session writer does. */
function sessionFile(
	id: string,
	count: number,
): { file: string; stamp: FileStamp; records: ReturnType<typeof entry>[] } {
	const file = path.join(dir, `${id}.jsonl`);
	const records = Array.from({ length: count }, (_, n) => entry(`${id}-${n}`, n ? `${id}-${n - 1}` : null));
	fs.writeFileSync(file, [header(id), ...records].map((line) => `${JSON.stringify(line)}\n`).join(""));
	return { file: fs.realpathSync(file), stamp: getFileStamp(file), records };
}
const save = (id: string, file: string, stamp: FileStamp, records: unknown[]): TranscriptCommand => ({
	kind: "save",
	sessionId: id,
	file,
	stamp,
	header: JSON.stringify(header(id)),
	records: (records as ReturnType<typeof entry>[]).map(asRow),
	workspace,
});
const rows = (id: string) => {
	const reader = openDatabase(locations);
	try {
		return transcripts.records(reader.mirror.db, id).map((line) => JSON.parse(line) as unknown);
	} finally {
		reader.close();
	}
};

it("reads a consistent file snapshot on the worker and keeps raw stored lines", async () => {
	const target = sessionFile("snapshot", 2500);
	fs.appendFileSync(target.file, "\nnull\n{broken\n");
	const dbWriter = writer();
	await expect(
		dbWriter.submit({
			kind: "save-file",
			sessionId: "snapshot",
			file: target.file,
			binding: target.stamp.binding,
			workspace,
		}),
	).resolves.toBe("saved");
	expect(rows("snapshot")).toEqual([expect.objectContaining({ id: "snapshot", type: "session" }), ...target.records]);
});

it("refuses a replaced or mismatched file before rebuilding its mirror", async () => {
	const target = sessionFile("snapshot", 1);
	const dbWriter = writer();
	const command = {
		kind: "save-file" as const,
		sessionId: "snapshot",
		file: target.file,
		binding: target.stamp.binding,
		workspace,
	};
	await expect(dbWriter.submit({ ...command, sessionId: "wrong" })).rejects.toThrow("identity changed");
	const replacement = path.join(dir, "replacement");
	fs.writeFileSync(replacement, JSON.stringify(header("snapshot")) + "\n");
	fs.renameSync(replacement, target.file);
	await expect(dbWriter.submit(command)).resolves.toBe("skipped");
	expect(rows("snapshot")).toEqual([]);
});

describe("database writer worker", () => {
	it("acknowledges after commit, applies deltas in order, and a read after the acknowledgement agrees", async () => {
		const db = writer();
		const { file, stamp, records } = sessionFile("s-order", 2);
		expect(await db.submit(save("s-order", file, stamp, records))).toBe("saved");
		expect(db.mode).toBe("worker");
		// Two appends sent back to back: the second is level only after the first committed.
		let previous = stamp;
		const sent: Promise<unknown>[] = [];
		for (const n of [2, 3]) {
			const record = entry(`s-order-${n}`, `s-order-${n - 1}`);
			fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
			const after = getFileStamp(file);
			sent.push(
				db.submit({
					kind: "sync",
					sessionId: "s-order",
					file,
					stamp: after,
					previous: { size: previous.size, mtime: previous.mtime },
					header: JSON.stringify(header("s-order")),
					entries: [{ position: n, record: asRow(record) }],
					workspace,
				}),
			);
			previous = after;
		}
		expect(await Promise.all(sent)).toEqual(["saved", "saved"]);
		const lines = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		expect(rows("s-order")).toEqual(lines);
		expect(await db.submit({ kind: "sync", sessionId: "s-order", file, stamp: getFileStamp(file), workspace })).toBe(
			"current",
		);
	});

	it("answers stale for a delta the mirror is not level with, and skips a file deleted after it was queued", async () => {
		const db = writer();
		const { file, stamp, records } = sessionFile("s-stale", 1);
		const record = entry("late", "s-stale-0");
		const delta: TranscriptCommand = {
			kind: "sync",
			sessionId: "s-stale",
			file,
			stamp,
			previous: { size: 1, mtime: "1" },
			header: JSON.stringify(header("s-stale")),
			entries: [{ position: 1, record: asRow(record) }],
			workspace,
		};
		expect(await db.submit(delta)).toBe("stale");
		fs.rmSync(file);
		expect(await db.submit(save("s-stale", file, stamp, records))).toBe("skipped");
		expect(rows("s-stale")).toEqual([]);
	});

	it("runs its worker without piping into this process's stdout and stderr, so writers add no listeners there", async () => {
		const count = () => [process.stdout.listenerCount("error"), process.stderr.listenerCount("error")];
		const before = count();
		const db = writer();
		const { file, stamp, records } = sessionFile("s-quiet", 1);
		expect(await db.submit(save("s-quiet", file, stamp, records))).toBe("saved");
		expect(db.mode).toBe("worker");
		// A piped worker adds one `error` listener to each stream for as long as it lives (one per writer in a process).
		expect(count()).toEqual(before);
	});

	it("rejects a failed command with its error and commits nothing", async () => {
		const db = writer();
		const first = sessionFile("s-owner", 1);
		expect(await db.submit(save("s-owner", first.file, first.stamp, first.records))).toBe("saved");
		const other = path.join(dir, "copy.jsonl");
		fs.copyFileSync(first.file, other);
		const copy = fs.realpathSync(other);
		const error = await db.submit(save("s-owner", copy, getFileStamp(copy), first.records)).catch((e) => e);
		expect(error).toBeInstanceOf(DbWriterCommandError);
		expect(writerErrorKind(error)).toBe("failed");
		expect((error as Error).message).toContain("Another transcript already uses this session ID");
		const reader = openDatabase(locations);
		try {
			expect(transcripts.stamp(reader.mirror.db, "s-owner")?.file).toBe(first.file);
		} finally {
			reader.close();
		}
	});

	it("names the kind of each writer error, and none for other errors", () => {
		expect(writerErrorKind(new DbWriterBusyError("full"))).toBe("queue-full");
		expect(writerErrorKind(new DbWriterUnavailableError("stopped"))).toBe("unavailable");
		expect(writerErrorKind(new DbWriterCommandError("database is locked", true))).toBe("db-busy");
		expect(writerErrorKind(new DbWriterCommandError("constraint failed", false))).toBe("failed");
		// A look-alike from elsewhere is not a writer error.
		expect(writerErrorKind(Object.assign(new Error("full"), { code: "DB_WRITER_BUSY" }))).toBeUndefined();
		expect(writerErrorKind(null)).toBeUndefined();
	});

	it("bounds its queue: past the limit a submit fails at once and sends nothing", async () => {
		const db = writer();
		const { file, stamp } = sessionFile("s-bound", 0);
		const check: TranscriptCommand = { kind: "sync", sessionId: "s-bound", file, stamp, workspace };
		const accepted = Array.from({ length: DB_WRITER_QUEUE_LIMIT }, () => db.submit(check));
		expect(db.pending).toBe(DB_WRITER_QUEUE_LIMIT);
		expect(db.canAccept()).toBe(false);
		const refused = await db.submit(check).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(DbWriterBusyError);
		expect(writerErrorKind(refused)).toBe("queue-full");
		expect(await Promise.all(accepted)).toHaveLength(DB_WRITER_QUEUE_LIMIT);
		expect(await db.drain(1_000)).toBe(true);
		expect(db.canAccept()).toBe(true);
	});

	it("releases timed-out drain observers while commands are still pending", async () => {
		const db = writer(new URL("data:text/javascript,setInterval(() => {}, 1000)"));
		const { file, stamp } = sessionFile("s-drain", 0);
		const pending = db.submit({ kind: "sync", sessionId: "s-drain", file, stamp, workspace }).catch(() => undefined);
		expect(await Promise.all(Array.from({ length: 32 }, () => db.drain(1)))).toEqual(Array(32).fill(false));
		expect(db.pending).toBe(1);
		expect((db as unknown as { idle: Set<unknown> }).idle.size).toBe(0);
		db.close();
		await pending;
	});

	it("waits for another process's lock on its own thread: a 10 ms timer here fires on time", async () => {
		const db = writer();
		const { file, stamp, records } = sessionFile("s-held", 3);
		// Create the schema first so the holder only takes the write lock.
		expect(await db.submit({ kind: "sync", sessionId: "s-held", file, stamp, workspace })).toBe("stale");
		const holder = await holdLock(400);
		const started = performance.now();
		const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
		const saved = db.submit(save("s-held", file, stamp, records));
		expect(await timer).toBeLessThan(150);
		expect(await saved).toBe("saved");
		expect(performance.now() - started).toBeGreaterThan(200);
		expect(rows("s-held")).toHaveLength(4);
		await holder.released();
	});

	it("keeps the lock retry budget when the worker's wall clock moves backwards", async () => {
		const workerEntry = new URL("../src/writer/worker-entry.ts", import.meta.url).href;
		const source = `
import { parentPort } from "node:worker_threads";
const now = Date.now;
parentPort.on("message", (request) => {
	if (request.command.kind !== "save") return;
	let first = true;
	Date.now = () => {
		const offset = first ? 0 : 60_000;
		first = false;
		return now() - offset;
	};
});
await import(${JSON.stringify(workerEntry)});
`;
		const db = writer(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
		const { file, stamp, records } = sessionFile("s-clock", 1);
		expect(await db.submit({ kind: "sync", sessionId: "s-clock", file, stamp, workspace })).toBe("stale");
		const holder = await holdLock(12_000);
		let deadline: NodeJS.Timeout | undefined;
		try {
			// After its first wall-clock read, the command sees a one-minute clock rollback.
			const result = await Promise.race([
				db.submit(save("s-clock", file, stamp, records)).then(
					() => "saved",
					(error: unknown) => error,
				),
				new Promise<string>((resolve) => {
					deadline = setTimeout(() => resolve("retry budget did not expire"), 8_000);
				}),
			]);
			expect(result).toBeInstanceOf(DbWriterCommandError);
			expect(writerErrorKind(result)).toBe("db-busy");
		} finally {
			clearTimeout(deadline);
			db.close();
			holder.stop();
			await holder.released();
		}
	});

	it("reports a worker that stops before acknowledging, then restarts for the next command", async () => {
		const db = writer();
		const { file, stamp, records } = sessionFile("s-crash", 1);
		expect(await db.submit({ kind: "sync", sessionId: "s-crash", file, stamp, workspace })).toBe("stale");
		// The command waits in the worker for another process's lock when the worker dies: it is never acknowledged.
		const holder = await holdLock(600);
		const lost = db.submit(save("s-crash", file, stamp, records));
		await new Promise((resolve) => setTimeout(resolve, 50));
		await (db as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
		const failure = await lost.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DbWriterUnavailableError);
		expect(writerErrorKind(failure)).toBe("unavailable");
		expect(db.mode).toBe("worker");
		await holder.released();
		expect(await db.submit(save("s-crash", file, stamp, records))).toBe("saved");
		expect(rows("s-crash")).toHaveLength(2);
	});

	it("runs the commands on this thread, in order, when the worker file cannot load", async () => {
		const db = writer(new URL("./missing-db-writer-entry.ts", import.meta.url));
		const { file, stamp, records } = sessionFile("s-inline", 2);
		const results = await Promise.all([
			db.submit(save("s-inline", file, stamp, records)),
			db.submit({ kind: "sync", sessionId: "s-inline", file, stamp, workspace }),
		]);
		expect(results).toEqual(["saved", "current"]);
		expect(db.mode).toBe("inline");
		expect(rows("s-inline")).toHaveLength(3);
		// The fallback is visible: why, and what ran on this thread.
		const stats = db.stats();
		expect(stats).toMatchObject({ mode: "inline", fallback: "load-failed", pending: 0, inlineRuns: 2 });
		expect(stats.inlineMaxMs).toBeLessThanOrEqual(stats.inlineMs);
	});

	it("reports a serving worker without a fallback", async () => {
		const db = writer();
		const { file, stamp, records } = sessionFile("s-stats", 1);
		expect(await db.submit(save("s-stats", file, stamp, records))).toBe("saved");
		expect(db.stats()).toEqual({
			role: "coordination",
			mode: "worker",
			pending: 0,
			restarts: 0,
			inlineRuns: 0,
			inlineMs: 0,
			inlineMaxMs: 0,
		});
	});

	it("on this thread, waits as briefly for another process's lock on the transcript mirror as on the coordination file", async () => {
		const db = writer(new URL("./missing-db-writer-entry.ts", import.meta.url));
		const { file, stamp, records } = sessionFile("s-mirror-held", 2);
		expect(await db.submit({ kind: "sync", sessionId: "s-mirror-held", file, stamp, workspace })).toBe("stale");
		expect(db.mode).toBe("inline");
		const holder = await holdLock(3_000, locations.mirrorFile);
		try {
			const started = performance.now();
			const error = await db.submit(save("s-mirror-held", file, stamp, records)).catch((each: unknown) => each);
			// The screen's thread gives up after the short inline wait, not the connection's five-second busy timeout.
			expect(writerErrorKind(error)).toBe("db-busy");
			expect(performance.now() - started).toBeLessThan(1_500);
		} finally {
			holder.stop();
			await holder.released();
		}
	});

	it("keeps rows another process saved from more of the same file over an older full snapshot", async () => {
		const db = writer();
		const { file, stamp: older, records } = sessionFile("s-newer", 1);
		const record = entry("s-newer-1", "s-newer-0");
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
		const newer = getFileStamp(file);
		expect(await db.submit(save("s-newer", file, newer, [...records, record]))).toBe("saved");
		// A snapshot taken before that append arrives last.
		expect(await db.submit(save("s-newer", file, older, records))).toBe("current");
		expect(rows("s-newer")).toHaveLength(3);
	});

	it("runs the commands here when the worker never reports that it loaded", async () => {
		const db = new DbWriter(locations, {
			entry: new URL("data:text/javascript,setInterval(() => {}, 1000)"),
			readyTimeoutMs: 200,
		});
		writers.push(db);
		const { file, stamp, records } = sessionFile("s-silent", 1);
		expect(await db.submit(save("s-silent", file, stamp, records))).toBe("saved");
		expect(db.mode).toBe("inline");
		expect(db.stats()).toMatchObject({ fallback: "load-failed", inlineRuns: 1 });
		expect(rows("s-silent")).toHaveLength(2);
	});

	it("opens the database again for a later command when it could not open it at first", async () => {
		fs.mkdirSync(path.dirname(locations.file), { recursive: true });
		fs.writeFileSync(locations.file, "not a database, but long enough to be read as a broken file header".repeat(8));
		const db = writer();
		const { file, stamp, records } = sessionFile("s-reopen", 1);
		const first = await db.submit(save("s-reopen", file, stamp, records)).catch((error: unknown) => error);
		expect(first).toBeInstanceOf(DbWriterCommandError);
		expect(db.mode).toBe("worker");
		fs.rmSync(locations.file);
		expect(await db.submit(save("s-reopen", file, stamp, records))).toBe("saved");
		expect(rows("s-reopen")).toHaveLength(2);
	});

	it("lets a process that ends on its own exit soon although its last command waits for a held database", async () => {
		const { file, stamp, records } = sessionFile("s-exit", 1);
		const seed = writer();
		expect(await seed.submit(save("s-exit", file, stamp, records))).toBe("saved");
		const holder = await holdLock(15_000);
		const script = path.join(dir, "exit-child.mts");
		fs.writeFileSync(
			script,
			`import { sharedDbWriter } from ${JSON.stringify(new URL("../src/api.ts", import.meta.url).href)};
const locations = ${JSON.stringify(locations)};
const command = { kind: "sync", sessionId: "s-exit", file: ${JSON.stringify(file)}, stamp: ${JSON.stringify(stamp)}, workspace: null };
for (let n = 0; n < 3; n++) sharedDbWriter(locations).submit(command).catch(() => undefined);
`,
		);
		const started = performance.now();
		const child = spawn(process.execPath, [script], { stdio: "ignore" });
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		const took = performance.now() - started;
		holder.stop();
		await holder.released();
		expect(code).toBe(0);
		expect(took).toBeLessThan(4_000);
	}, 20_000);
});

it("releases startup deadlines across repeated writer closes before readiness", async () => {
	vi.useFakeTimers();
	try {
		const baseline = vi.getTimerCount();
		const fixture = sessionFile("closing", 0);
		for (let cycle = 0; cycle < 10; cycle++) {
			const instance = writer(new URL("data:text/javascript,setInterval(() => {}, 1000)"));
			const result = instance.submit(save("closing", fixture.file, fixture.stamp, [])).catch((error: unknown) => error);
			expect(vi.getTimerCount()).toBe(baseline + 1);
			instance.close();
			instance.close();
			expect(vi.getTimerCount()).toBe(baseline);
			expect(await result).toBeInstanceOf(DbWriterUnavailableError);
		}
	} finally {
		vi.useRealTimers();
	}
});
