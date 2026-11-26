import type { DatabaseSync } from "node:sqlite";

const EVENT_LOG_TABLE = `
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT,
  at INTEGER NOT NULL, topic TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
  digest TEXT NOT NULL, ref TEXT, dedupe_key TEXT, UNIQUE(workspace_id, dedupe_key));`;

const EVENT_LOG_INDEXES = `
CREATE INDEX IF NOT EXISTS event_log_topic ON event_log(workspace_id, topic, seq);
CREATE INDEX IF NOT EXISTS event_log_key ON event_log(workspace_id, key, seq);
CREATE INDEX IF NOT EXISTS event_log_at ON event_log(at);`;

/**
 * Rebuilds an early version-10 `event_log` whose UNIQUE(dedupe_key) constraint crossed workspace boundaries; a table
 * that already has the per-workspace key is left as it is. Runs inside the caller's upgrade transaction.
 */
export function upgradeWorkspaceEventKeys(db: DatabaseSync): void {
	const global = db
		.prepare(`SELECT 1 FROM pragma_index_list('event_log') AS idx
		JOIN pragma_index_info(idx.name) AS col ON col.seqno = 0
		WHERE idx.origin = 'u' AND col.name = 'dedupe_key'`)
		.get();
	if (!global) return;
	db.exec(`ALTER TABLE event_log RENAME TO event_log_global_dedupe;
		${EVENT_LOG_TABLE}
		INSERT INTO event_log SELECT * FROM event_log_global_dedupe;
		-- Retention may have deleted every row at or below a subscription's last delivered seq.
		UPDATE sqlite_sequence SET seq = max(seq, coalesce(
			(SELECT seq FROM sqlite_sequence WHERE name = 'event_log_global_dedupe'), 0))
			WHERE name = 'event_log';
		DROP TABLE event_log_global_dedupe;
		${EVENT_LOG_INDEXES}`);
}

/**
 * The durable event log, its subscriptions and the callback tickets (`queries/events.ts`, `queries/event-subscriptions.ts`,
 * `queries/tickets.ts`). A ticket is a request one agent made of another that a reply or an event resolves at most once; its
 * result is an `event_log` row. The subscription table cannot hold it: that one is unique per subscriber, topic and filter.
 * `event_log` is the
 * ordered record of what happened to the agent runtime (`seq` is the order and the replay cursor); `event_subscriptions`
 * holds who reads it, from which `offset_seq`. Both are separate from `agent_events`, the presence audit: that table has
 * its own id, version and keep-the-newest retention, and never carries topics, dedupe or consumer offsets. Created with IF NOT EXISTS: a
 * version-10 file gains them in its upgrade (`schema-migrations.ts`). `source`, `payload`, `ref`, `filter`
 * and `action` are JSON text the caller serialized; the database never reads inside them.
 */
export const EVENTS_SCHEMA = `
${EVENT_LOG_TABLE}
${EVENT_LOG_INDEXES}
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT,
  subscriber TEXT NOT NULL, topic TEXT NOT NULL, filter TEXT NOT NULL DEFAULT '',
  deliver TEXT NOT NULL CHECK(deliver IN ('wake','piggyback','record')), durable INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL, once INTEGER NOT NULL DEFAULT 0, cost_max_per_hour INTEGER,
  offset_seq INTEGER NOT NULL DEFAULT 0, owner_pid INTEGER, owner_started TEXT,
  expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, subscriber, topic, filter));
CREATE INDEX IF NOT EXISTS event_subscriptions_expiry ON event_subscriptions(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_subscriptions_owner ON event_subscriptions(owner_pid);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT,
  requester TEXT NOT NULL, target TEXT NOT NULL,
  on_kind TEXT NOT NULL CHECK(on_kind IN ('reply','done','item.state','job.exit','agent.ended')),
  filter TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', request_message INTEGER, text_hash TEXT NOT NULL,
  depth INTEGER NOT NULL, chain TEXT NOT NULL, deadline INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','resolved','rejected','cancelled')),
  created_at INTEGER NOT NULL, resolved_at INTEGER, result_seq INTEGER, reason TEXT);
CREATE INDEX IF NOT EXISTS tickets_requester ON tickets(workspace_id, requester) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS tickets_target ON tickets(workspace_id, target) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS tickets_request ON tickets(request_message) WHERE request_message IS NOT NULL;
`;
