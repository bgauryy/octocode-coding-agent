/**
 * The sample tables the monitor writes (`queries/machine-samples.ts`, `queries/process-samples.ts`): per-minute samples of
 * the whole machine with the lease that lets one Octocode process at a time take them, and periodic memory samples of
 * Octocode processes with the children each owned. Rebuildable like leases and timers.
 */
export const SAMPLES_SCHEMA = `
CREATE TABLE machine_samples (
  at INTEGER PRIMARY KEY, load1 REAL NOT NULL, load5 REAL NOT NULL, load15 REAL NOT NULL, cores INTEGER NOT NULL,
  mem_total INTEGER NOT NULL, mem_available INTEGER, swap_used INTEGER NOT NULL, swap_total INTEGER NOT NULL,
  gpu REAL, processes TEXT NOT NULL DEFAULT '[]');
CREATE TABLE machine_sampler (
  id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE process_samples (
  at INTEGER NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', ppid INTEGER NOT NULL,
  role TEXT NOT NULL, title TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, agent_id TEXT,
  owner_pid INTEGER, owner_started TEXT, rss INTEGER NOT NULL, heap_used INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0, children TEXT NOT NULL DEFAULT '[]', cwd TEXT,
  PRIMARY KEY (pid, started, at));
CREATE INDEX process_samples_at ON process_samples(at);
`;
