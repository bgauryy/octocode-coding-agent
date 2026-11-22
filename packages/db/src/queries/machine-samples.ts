import type { DatabaseSync } from "node:sqlite";

/**
 * Per-minute samples of the whole machine (load, memory, swap, GPU and the busiest processes) for the threshold monitor,
 * and the lease that lets one Octocode process at a time take them. Every process reads the samples; only the lease
 * holder writes. The tables are part of the coordination schema (`schema-samples.ts`).
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
	/** The title (`octocode-agent-<role>-<id>`) of the Octocode process it is or runs under; null for other processes. */
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

/** A threshold the publisher decided to raise: what `MachineAlert` (`monitor/rules.ts`) holds, as stored. */
export interface MachineAlertRow {
	/** The order the table gave it; the cursor a reader keeps. */
	seq: number;
	at: number;
	rule: string;
	value: number;
	threshold: number;
	streak: number;
	/** The Octocode process title whose processes cause it; null when none does. */
	owner: string | null;
	culprits: MachineProcess[];
}

/** The process that takes the samples until `expiresAt`. */
export interface SamplerLease {
	holder: string;
	pid: number;
	acquiredAt: number;
	expiresAt: number;
}

/** Writes one sample; a second sample at the same instant replaces the first. */
export function record(db: DatabaseSync, sample: MachineSample): void {
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
	const rows = db.prepare("SELECT * FROM machine_samples WHERE at >= ? ORDER BY at").all(at);
	return (rows as unknown as SampleRow[]).map(toSample);
}

/** The load and core count of the newest `count` samples, newest first; the process list is not read. */
export function recentLoads(db: DatabaseSync, count: number): Array<{ load1: number; cores: number }> {
	return db
		.prepare("SELECT load1, cores FROM machine_samples ORDER BY at DESC LIMIT ?")
		.all(count) as unknown as Array<{
		load1: number;
		cores: number;
	}>;
}

/** The newest sample, if any. */
export function latest(db: DatabaseSync): MachineSample | undefined {
	const row = db.prepare("SELECT * FROM machine_samples ORDER BY at DESC LIMIT 1").get();
	return row ? toSample(row as unknown as SampleRow) : undefined;
}

/** Deletes the samples and alerts from before `at` (ms since the epoch), the retention rule; returns how many samples went. */
export function pruneBefore(db: DatabaseSync, at: number): number {
	db.prepare("DELETE FROM machine_alerts WHERE at < ?").run(at);
	return Number(db.prepare("DELETE FROM machine_samples WHERE at < ?").run(at).changes);
}

/** Files an alert the publisher raised; returns its `seq`. */
export function recordAlert(db: DatabaseSync, alert: Omit<MachineAlertRow, "seq">): number {
	return Number(
		db
			.prepare(
				"INSERT INTO machine_alerts (at, rule, value, threshold, streak, owner, culprits) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				alert.at,
				alert.rule,
				alert.value,
				alert.threshold,
				alert.streak,
				alert.owner,
				JSON.stringify(alert.culprits),
			).lastInsertRowid,
	);
}

/** The newest alert's `seq`, or 0: where a reader that starts now begins. */
export function lastAlertSeq(db: DatabaseSync): number {
	const row = db.prepare("SELECT MAX(seq) AS seq FROM machine_alerts").get() as { seq: number | null };
	return row.seq ?? 0;
}

/** The alerts after `seq`, oldest first. */
export function alertsAfter(db: DatabaseSync, seq: number): MachineAlertRow[] {
	const rows = db.prepare("SELECT * FROM machine_alerts WHERE seq > ? ORDER BY seq").all(seq) as unknown as Array<
		Omit<MachineAlertRow, "culprits"> & { culprits: string }
	>;
	return rows.map((row) => ({ ...row, culprits: parseProcesses(row.culprits) }));
}

/** All-data purge: drops every sample and the lease, without creating the optional tables; returns how many samples went. */
export function clear(db: DatabaseSync): number {
	if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='machine_samples'").get()) return 0;
	db.prepare("DELETE FROM machine_sampler").run();
	db.prepare("DELETE FROM machine_alerts").run();
	return Number(db.prepare("DELETE FROM machine_samples").run().changes);
}

/**
 * Takes or renews the sampler lease for `holder` until `now + ttlMs`, in one statement: it succeeds when nobody holds it,
 * when `holder` already does, or when the previous holder's lease ran out (a process that died without releasing).
 * Returns whether `holder` holds it now.
 */
export function acquire(db: DatabaseSync, holder: string, pid: number, now: number, ttlMs: number): boolean {
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
	return Number(db.prepare("DELETE FROM machine_sampler WHERE holder = ?").run(holder).changes) > 0;
}

/** The unexpired lease at `now`, if any. */
export function holderAt(db: DatabaseSync, now: number): SamplerLease | undefined {
	const row = db.prepare("SELECT * FROM machine_sampler WHERE expires_at > ?").get(now) as
		| { holder: string; pid: number; acquired_at: number; expires_at: number }
		| undefined;
	return row ? { holder: row.holder, pid: row.pid, acquiredAt: row.acquired_at, expiresAt: row.expires_at } : undefined;
}
