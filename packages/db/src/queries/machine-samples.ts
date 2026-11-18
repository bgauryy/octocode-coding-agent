import type { DatabaseSync } from "node:sqlite";

/**
 * Per-minute samples of the whole machine (load, memory, swap, GPU and the busiest processes) for the threshold monitor,
 * and the lease that lets one Octocode process at a time take them. Every process reads the samples; only the lease
 * holder writes. The tables are created on first use (`IF NOT EXISTS`) instead of with the schema, so the schema version
 * is unchanged and an Octocode of another version sharing the file keeps working.
 */

/** One of the busiest processes when the machine was sampled. */
export interface MachineProcess {
	pid: number;
	/** Its parent when sampled. */
	ppid: number;
	/** The command's short name. */
	command: string;
	/** CPU use in percent of one core (above 100 for a process using several). */
	cpu: number;
	/** Resident set size in bytes. */
	rss: number;
	/** The title (`octocode-<role>-<id>`) of the Octocode process it is or runs under; null for other processes. */
	owner: string | null;
}

export interface MachineSample {
	/** Milliseconds since the epoch. */
	at: number;
	/** Load averages over 1, 5 and 15 minutes (0 where the platform has none). */
	load1: number;
	load5: number;
	load15: number;
	/** Logical CPUs. */
	cores: number;
	/** Bytes. */
	memTotal: number;
	/** Bytes the system can still hand out without swapping; null when the platform does not say. */
	memAvailable: number | null;
	/** Bytes; zero when there is no swap. */
	swapUsed: number;
	swapTotal: number;
	/** GPU utilization in percent; null when it could not be read. */
	gpu: number | null;
	/** The busiest processes, most CPU first. */
	processes: MachineProcess[];
}

/** The process that takes the samples until `expiresAt`. */
export interface SamplerLease {
	holder: string;
	pid: number;
	acquiredAt: number;
	expiresAt: number;
}

const created = new WeakSet<DatabaseSync>();

function ensure(db: DatabaseSync): void {
	if (created.has(db)) return;
	db.exec(`
CREATE TABLE IF NOT EXISTS machine_samples (
  at INTEGER PRIMARY KEY, load1 REAL NOT NULL, load5 REAL NOT NULL, load15 REAL NOT NULL, cores INTEGER NOT NULL,
  mem_total INTEGER NOT NULL, mem_available INTEGER, swap_used INTEGER NOT NULL, swap_total INTEGER NOT NULL,
  gpu REAL, processes TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS machine_sampler (
  id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
	created.add(db);
}

/** Writes one sample; a second sample at the same instant replaces the first. */
export function record(db: DatabaseSync, sample: MachineSample): void {
	ensure(db);
	db.prepare(
		`INSERT OR REPLACE INTO machine_samples
		 (at, load1, load5, load15, cores, mem_total, mem_available, swap_used, swap_total, gpu, processes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		sample.at,
		sample.load1,
		sample.load5,
		sample.load15,
		sample.cores,
		sample.memTotal,
		sample.memAvailable,
		sample.swapUsed,
		sample.swapTotal,
		sample.gpu,
		JSON.stringify(sample.processes),
	);
}

interface SampleRow {
	at: number;
	load1: number;
	load5: number;
	load15: number;
	cores: number;
	mem_total: number;
	mem_available: number | null;
	swap_used: number;
	swap_total: number;
	gpu: number | null;
	processes: string;
}

function parseProcesses(text: string): MachineProcess[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? (parsed as MachineProcess[]) : [];
	} catch {
		// A row another version wrote with a different shape reads as no processes; its machine figures still count.
		return [];
	}
}

const toSample = (row: SampleRow): MachineSample => ({
	at: row.at,
	load1: row.load1,
	load5: row.load5,
	load15: row.load15,
	cores: row.cores,
	memTotal: row.mem_total,
	memAvailable: row.mem_available,
	swapUsed: row.swap_used,
	swapTotal: row.swap_total,
	gpu: row.gpu,
	processes: parseProcesses(row.processes),
});

/** Every sample taken at or after `at` (ms since the epoch), oldest first. */
export function since(db: DatabaseSync, at: number): MachineSample[] {
	ensure(db);
	const rows = db.prepare("SELECT * FROM machine_samples WHERE at >= ? ORDER BY at").all(at);
	return (rows as unknown as SampleRow[]).map(toSample);
}

/** The newest sample, if any. */
export function latest(db: DatabaseSync): MachineSample | undefined {
	ensure(db);
	const row = db.prepare("SELECT * FROM machine_samples ORDER BY at DESC LIMIT 1").get();
	return row ? toSample(row as unknown as SampleRow) : undefined;
}

/** Deletes the samples taken before `at` (ms since the epoch), the retention rule; returns how many went. */
export function pruneBefore(db: DatabaseSync, at: number): number {
	ensure(db);
	return Number(db.prepare("DELETE FROM machine_samples WHERE at < ?").run(at).changes);
}

/** All-data purge: drops every sample and the lease, without creating the optional tables; returns how many samples went. */
export function clear(db: DatabaseSync): number {
	if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='machine_samples'").get()) return 0;
	db.prepare("DELETE FROM machine_sampler").run();
	return Number(db.prepare("DELETE FROM machine_samples").run().changes);
}

/**
 * Takes or renews the sampler lease for `holder` until `now + ttlMs`, in one statement: it succeeds when nobody holds it,
 * when `holder` already does, or when the previous holder's lease ran out (a process that died without releasing).
 * Returns whether `holder` holds it now.
 */
export function acquire(db: DatabaseSync, holder: string, pid: number, now: number, ttlMs: number): boolean {
	ensure(db);
	const changes = db
		.prepare(
			`INSERT INTO machine_sampler (id, holder, pid, acquired_at, expires_at) VALUES (1, ?1, ?2, ?3, ?4)
			 ON CONFLICT(id) DO UPDATE SET
			   acquired_at = CASE WHEN holder = excluded.holder THEN acquired_at ELSE excluded.acquired_at END,
			   holder = excluded.holder, pid = excluded.pid, expires_at = excluded.expires_at
			 WHERE holder = excluded.holder OR expires_at <= ?3`,
		)
		.run(holder, pid, now, now + ttlMs).changes;
	return Number(changes) > 0;
}

/** Gives the lease up if `holder` has it, so another process can take over at once; returns whether it did. */
export function release(db: DatabaseSync, holder: string): boolean {
	ensure(db);
	return Number(db.prepare("DELETE FROM machine_sampler WHERE holder = ?").run(holder).changes) > 0;
}

/** The unexpired lease at `now`, if any. */
export function holderAt(db: DatabaseSync, now: number): SamplerLease | undefined {
	ensure(db);
	const row = db.prepare("SELECT * FROM machine_sampler WHERE expires_at > ?").get(now) as
		| { holder: string; pid: number; acquired_at: number; expires_at: number }
		| undefined;
	return row ? { holder: row.holder, pid: row.pid, acquiredAt: row.acquired_at, expiresAt: row.expires_at } : undefined;
}
