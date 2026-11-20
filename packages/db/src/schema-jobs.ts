/**
 * Jobs (`queries/jobs.ts`): the background `bash` jobs of every session, one row per job, so another session or the work
 * graph sees what runs. `job` is the session's own id (`bash-4`); `key` is the hash of the workspace, folder and
 * normalized command that makes an identical start join a running job. A row is shown and matched only: the private owner
 * record of the job (`pid` and `log` find it) stays the only authority to signal a process. Rebuildable like leases
 * and timers, so a schema bump drops it. Written with IF NOT EXISTS so `amendCoordination` adds it to an older file in place.
 */
export const JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL,
  job TEXT NOT NULL, agent TEXT, item TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, key TEXT NOT NULL,
  pid INTEGER NOT NULL, host TEXT, log TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','finished','stopped')), exit_code INTEGER,
  started_at INTEGER NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL,
  CHECK((state = 'running') = (ended_at IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS jobs_session_job ON jobs(session_id, job);
CREATE INDEX IF NOT EXISTS jobs_running ON jobs(workspace_id, key) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS jobs_ended ON jobs(ended_at) WHERE state <> 'running';
`;
