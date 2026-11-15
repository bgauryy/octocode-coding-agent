/** Additive on schema10 files; legacy rows and writers leave the capability unset. */
export const AGENT_MAILBOX_COLUMN = "mailbox TEXT CHECK(mailbox IS NULL OR mailbox = 'pull')";

/** `shell_history`: the commands the user ran with `!`, one row per folder and command, for the editor's suggestions. */
const SHELL_HISTORY_SCHEMA = `
CREATE TABLE shell_history (
  cwd TEXT NOT NULL, command TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, last_at INTEGER NOT NULL, last_exit INTEGER,
  PRIMARY KEY (cwd, command));
CREATE INDEX shell_history_recent ON shell_history(last_at);
`;

/**
 * `item_reviews`: the user's review decisions about hooks, MCP servers and skills that Octocode did not ship, one row
 * per item and scope (`queries/guard.ts`). Written with IF NOT EXISTS so a file created before the table existed gains
 * it at first use (`guard.ensure`) without a schema version change, which would set the whole file aside.
 */
export const ITEM_REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, identity TEXT NOT NULL, scope TEXT NOT NULL,
  content_hash TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','denied','seen')),
  rating TEXT NOT NULL, findings TEXT NOT NULL DEFAULT '[]', label TEXT NOT NULL, path TEXT NOT NULL,
  decided_at INTEGER NOT NULL, decided_via TEXT NOT NULL, absent_at INTEGER,
  UNIQUE(kind, identity, scope));
`;

/** The audit table of agent runs and its indexes. */
const AGENT_RUNS_SCHEMA = `
CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY, registration_id TEXT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('main','child')), parent_agent_id TEXT, parent_session_id TEXT, session_id TEXT,
  started_by TEXT, profile TEXT, model TEXT, goal TEXT, backlog_workspace TEXT, backlog_seq INTEGER,
  cwd TEXT, branch TEXT, process_title TEXT, pid INTEGER,
  started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, end_detail TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, unpriced INTEGER NOT NULL DEFAULT 0,
  outcome TEXT, outcome_source TEXT, report_path TEXT, files_changed TEXT,
  cache_write INTEGER NOT NULL DEFAULT 0);
CREATE INDEX agent_runs_agent ON agent_runs(agent_id, started_at DESC);
CREATE INDEX agent_runs_workspace ON agent_runs(workspace_id, started_at DESC);
CREATE INDEX agent_runs_item ON agent_runs(backlog_workspace, backlog_seq) WHERE backlog_seq IS NOT NULL;
CREATE INDEX agent_runs_session ON agent_runs(session_id);
CREATE INDEX agent_runs_registration ON agent_runs(registration_id);
`;

/**
 * Timers (`queries/timers.ts`): a session's own wakes. `once` wakes at `due_at`; `every` wakes every `interval_ms` until
 * `max_runs` or `deadline_at`; `until` checks its condition (`condition_kind`: `command` exits 0 in `cwd`, `unlocked`: no
 * other agent's reservation covers the path in `condition`; `file`, `item`, `agent`, `port` and `check` store their fields
 * as JSON in `condition`) every `interval_ms` and wakes once when it is met or the deadline passes. `baseline` is what a
 * `file` or `check` condition compares against (set at creation); `checks` and `spent_usd` count a `check`'s model calls
 * and their cost. Only the owner session (`session_id`) fires a row; a fire claims it with one guarded UPDATE.
 */
const TIMERS_SCHEMA = `
CREATE TABLE timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL,
  agent TEXT, tool_call_id TEXT, note TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('once','every','until')), due_at INTEGER NOT NULL, interval_ms INTEGER,
  condition_kind TEXT CHECK(condition_kind IN ('command','unlocked','file','item','agent','port','check')), condition TEXT, cwd TEXT,
  max_runs INTEGER, runs INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','expired','failed')), stop_reason TEXT,
  last_fired_at INTEGER, last_exit INTEGER, last_output TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER,
  baseline TEXT, checks INTEGER NOT NULL DEFAULT 0, spent_usd REAL NOT NULL DEFAULT 0,
  CHECK((kind = 'once') = (interval_ms IS NULL)),
  CHECK((kind = 'until') = (condition_kind IS NOT NULL)),
  CHECK((condition_kind IS NULL) = (condition IS NULL)));
CREATE INDEX timers_due ON timers(session_id, due_at) WHERE status = 'active';
CREATE INDEX timers_ended ON timers(ended_at) WHERE status <> 'active';
`;

/**
 * The audit triggers on `backlog`: every insert, update and delete files a row with the acting `octocode_audit_actor()`.
 */
const BACKLOG_AUDIT_TRIGGERS = `
CREATE TRIGGER backlog_audits_insert AFTER INSERT ON backlog BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.workspace_id, 'B' || NEW.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog', NULL, json_object('id', NEW.id, 'workspace_id', NEW.workspace_id, 'seq', NEW.seq, 'title', NEW.title, 'goal', NEW.goal, 'body', NEW.body, 'paths', NEW.paths, 'why', NEW.why, 'evidence', NEW.evidence, 'plan', NEW.plan, 'state', NEW.state, 'priority', NEW.priority, 'tags', NEW.tags, 'assignee', NEW.assignee, 'created_by', NEW.created_by, 'source_session', NEW.source_session, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'started_at', NEW.started_at, 'done_at', NEW.done_at, 'from_item', NEW.from_item, 'version', NEW.version, 'type', NEW.type, 'parent_id', NEW.parent_id, 'closed', NEW.closed, 'rank', NEW.rank);
END;
CREATE TRIGGER backlog_audits_update AFTER UPDATE ON backlog BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.workspace_id, 'B' || NEW.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog', json_object('id', OLD.id, 'workspace_id', OLD.workspace_id, 'seq', OLD.seq, 'title', OLD.title, 'goal', OLD.goal, 'body', OLD.body, 'paths', OLD.paths, 'why', OLD.why, 'evidence', OLD.evidence, 'plan', OLD.plan, 'state', OLD.state, 'priority', OLD.priority, 'tags', OLD.tags, 'assignee', OLD.assignee, 'created_by', OLD.created_by, 'source_session', OLD.source_session, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'started_at', OLD.started_at, 'done_at', OLD.done_at, 'from_item', OLD.from_item, 'version', OLD.version, 'type', OLD.type, 'parent_id', OLD.parent_id, 'closed', OLD.closed, 'rank', OLD.rank), json_object('id', NEW.id, 'workspace_id', NEW.workspace_id, 'seq', NEW.seq, 'title', NEW.title, 'goal', NEW.goal, 'body', NEW.body, 'paths', NEW.paths, 'why', NEW.why, 'evidence', NEW.evidence, 'plan', NEW.plan, 'state', NEW.state, 'priority', NEW.priority, 'tags', NEW.tags, 'assignee', NEW.assignee, 'created_by', NEW.created_by, 'source_session', NEW.source_session, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'started_at', NEW.started_at, 'done_at', NEW.done_at, 'from_item', NEW.from_item, 'version', NEW.version, 'type', NEW.type, 'parent_id', NEW.parent_id, 'closed', NEW.closed, 'rank', NEW.rank);
END;
CREATE TRIGGER backlog_audits_delete AFTER DELETE ON backlog BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT OLD.workspace_id, 'B' || OLD.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog', json_object('id', OLD.id, 'workspace_id', OLD.workspace_id, 'seq', OLD.seq, 'title', OLD.title, 'goal', OLD.goal, 'body', OLD.body, 'paths', OLD.paths, 'why', OLD.why, 'evidence', OLD.evidence, 'plan', OLD.plan, 'state', OLD.state, 'priority', OLD.priority, 'tags', OLD.tags, 'assignee', OLD.assignee, 'created_by', OLD.created_by, 'source_session', OLD.source_session, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'started_at', OLD.started_at, 'done_at', OLD.done_at, 'from_item', OLD.from_item, 'version', OLD.version, 'type', OLD.type, 'parent_id', OLD.parent_id, 'closed', OLD.closed, 'rank', OLD.rank), NULL;
END;
`;

export const SCHEMA = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, root TEXT NOT NULL, binding TEXT NOT NULL,
  git_common_dir TEXT, linked_worktree INTEGER CHECK(linked_worktree IN (0,1)),
  CHECK((git_common_dir IS NULL) = (linked_worktree IS NULL)));
CREATE INDEX workspaces_root ON workspaces(root);
CREATE INDEX workspaces_git ON workspaces(git_common_dir, name, root, id) WHERE git_common_dir IS NOT NULL;
CREATE INDEX workspaces_name ON workspaces(name, root, id);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), branch TEXT, head TEXT,
  cost REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, files_changed INTEGER NOT NULL DEFAULT 0, pid INTEGER,
  pid_started TEXT, unpriced INTEGER NOT NULL DEFAULT 0, dir TEXT,
  title TEXT, title_source TEXT, cwd TEXT, file TEXT, parent_file TEXT, created_at INTEGER, last_active INTEGER,
  message_count INTEGER, first_prompt TEXT, file_mtime INTEGER, UNIQUE(id, workspace_id));
CREATE INDEX sessions_workspace ON sessions(workspace_id);
CREATE INDEX sessions_catalog ON sessions(cwd) WHERE file IS NOT NULL;

CREATE TABLE backlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), seq INTEGER NOT NULL,
  title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  paths TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('backlog','todo','ongoing','done')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3), tags TEXT NOT NULL DEFAULT '',
  assignee TEXT, created_by TEXT NOT NULL, source_session TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, done_at INTEGER,
  from_item INTEGER, version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'feature' CHECK(type IN ('epic','feature','bug','research')), parent_id INTEGER, closed TEXT, rank REAL,
  UNIQUE(workspace_id, seq), UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, parent_id) REFERENCES backlog(workspace_id, id),
  FOREIGN KEY(workspace_id, from_item) REFERENCES backlog(workspace_id, id));
CREATE TABLE backlog_links (
  item INTEGER NOT NULL REFERENCES backlog(id) ON DELETE CASCADE,
  relation TEXT NOT NULL, target TEXT NOT NULL, UNIQUE(item, relation, target));
CREATE TABLE backlog_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL REFERENCES backlog(id),
  operation_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(item, operation_key));
CREATE INDEX backlog_parent ON backlog(parent_id);
CREATE TRIGGER backlog_writer_insert BEFORE INSERT ON backlog BEGIN
 SELECT CASE WHEN octocode_backlog_writer() != 1 THEN RAISE(ABORT, 'Upgrade Octocode to edit backlogs') END;
END;
CREATE TRIGGER backlog_writer_update BEFORE UPDATE ON backlog BEGIN
 SELECT CASE WHEN octocode_backlog_writer() != 1 THEN RAISE(ABORT, 'Upgrade Octocode to edit backlogs') END;
END;
CREATE TRIGGER backlog_writer_delete BEFORE DELETE ON backlog BEGIN
 SELECT CASE WHEN octocode_backlog_writer() != 1 THEN RAISE(ABORT, 'Upgrade Octocode to edit backlogs') END;
END;
CREATE INDEX backlog_board ON backlog(workspace_id, state, priority, updated_at);
CREATE INDEX backlog_from ON backlog(from_item) WHERE from_item IS NOT NULL;
CREATE INDEX backlog_assignee ON backlog(assignee, state) WHERE assignee IS NOT NULL;
CREATE INDEX backlog_seq ON backlog(seq);
CREATE TABLE backlog_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL REFERENCES backlog(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','change')), text TEXT NOT NULL);
CREATE INDEX backlog_notes_item ON backlog_notes(item, at);

CREATE TABLE backlog_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL REFERENCES backlog(id) ON DELETE CASCADE,
  note_id INTEGER UNIQUE REFERENCES backlog_notes(id) ON DELETE CASCADE, at INTEGER NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX backlog_comments_item ON backlog_comments(item, id);
CREATE TABLE backlog_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), backlog_id TEXT NOT NULL,
  at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
  before_value TEXT, after_value TEXT);
CREATE INDEX backlog_audits_item ON backlog_audits(workspace_id, backlog_id, id);
CREATE TRIGGER backlog_audits_immutable_update BEFORE UPDATE ON backlog_audits BEGIN
 SELECT RAISE(ABORT, 'Audit events are immutable');
END;
CREATE TRIGGER backlog_audits_immutable_delete BEFORE DELETE ON backlog_audits BEGIN
 SELECT RAISE(ABORT, 'Audit events are immutable');
END;
CREATE TRIGGER backlog_audits_skip_noop BEFORE INSERT ON backlog_audits WHEN NEW.action = 'update' AND json_remove(NEW.before_value, '$.updated_at', '$.version') IS json_remove(NEW.after_value, '$.updated_at', '$.version') BEGIN
 SELECT RAISE(IGNORE);
END;
CREATE TRIGGER backlog_comments_immutable_update BEFORE UPDATE ON backlog_comments BEGIN
 SELECT RAISE(ABORT, 'Comments are immutable; add a correction');
END;
CREATE TRIGGER backlog_comments_immutable_delete BEFORE DELETE ON backlog_comments WHEN EXISTS (SELECT 1 FROM backlog WHERE id = OLD.item) BEGIN
 SELECT RAISE(ABORT, 'Comments are immutable; add a correction');
END;
CREATE TRIGGER backlog_notes_immutable_update BEFORE UPDATE ON backlog_notes BEGIN
 SELECT RAISE(ABORT, 'Notes are immutable; add a correction');
END;
CREATE TRIGGER backlog_note_comment AFTER INSERT ON backlog_notes WHEN NEW.kind = 'note' BEGIN
 INSERT INTO backlog_comments(item, note_id, at, author, text) VALUES (NEW.item, NEW.id, NEW.at, NEW.author, NEW.text);
END;
${BACKLOG_AUDIT_TRIGGERS}
CREATE TRIGGER backlog_links_audit_insert AFTER INSERT ON backlog_links BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_links', NULL, json_object('item', NEW.item, 'relation', NEW.relation, 'target', NEW.target) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_links_audit_update AFTER UPDATE ON backlog_links BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog_links', json_object('item', OLD.item, 'relation', OLD.relation, 'target', OLD.target), json_object('item', NEW.item, 'relation', NEW.relation, 'target', NEW.target) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_links_audit_delete AFTER DELETE ON backlog_links BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_links', json_object('item', OLD.item, 'relation', OLD.relation, 'target', OLD.target), NULL FROM backlog b WHERE b.id = OLD.item;
END;
CREATE TRIGGER backlog_completions_audit_insert AFTER INSERT ON backlog_completions BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_completions', NULL, json_object('id', NEW.id, 'item', NEW.item, 'operation_key', NEW.operation_key, 'payload', NEW.payload) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_completions_audit_delete AFTER DELETE ON backlog_completions BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_completions', json_object('id', OLD.id, 'item', OLD.item, 'operation_key', OLD.operation_key, 'payload', OLD.payload), NULL FROM backlog b WHERE b.id = OLD.item;
END;
CREATE TRIGGER backlog_comments_audit_insert AFTER INSERT ON backlog_comments BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_comments', NULL, json_object('id', NEW.id, 'item', NEW.item, 'at', NEW.at, 'author', NEW.author, 'text', NEW.text) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_comments_audit_delete AFTER DELETE ON backlog_comments BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_comments', json_object('id', OLD.id, 'item', OLD.item, 'at', OLD.at, 'author', OLD.author, 'text', OLD.text), NULL FROM backlog b WHERE b.id = OLD.item;
END;

CREATE TABLE backlog_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), seq INTEGER NOT NULL,
  item_id INTEGER, session_id TEXT,
  goal TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','ongoing','done','dropped')),
  position INTEGER NOT NULL DEFAULT 0, assignee TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id, seq),
  FOREIGN KEY(workspace_id, item_id) REFERENCES backlog(workspace_id, id) ON DELETE CASCADE,
  CHECK((item_id IS NULL) <> (session_id IS NULL)));
CREATE INDEX backlog_tasks_item ON backlog_tasks(item_id, position, id) WHERE item_id IS NOT NULL;
CREATE INDEX backlog_tasks_session ON backlog_tasks(workspace_id, session_id, position, id) WHERE session_id IS NOT NULL;
CREATE INDEX backlog_tasks_state ON backlog_tasks(workspace_id, state);
CREATE TRIGGER backlog_tasks_audit_insert AFTER INSERT ON backlog_tasks BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.workspace_id, COALESCE((SELECT 'B' || seq FROM backlog WHERE id = NEW.item_id), 'T' || NEW.seq), CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_tasks', NULL, json_object('id', NEW.id, 'seq', NEW.seq, 'item_id', NEW.item_id, 'session_id', NEW.session_id, 'goal', NEW.goal, 'reason', NEW.reason, 'result', NEW.result, 'state', NEW.state, 'position', NEW.position, 'assignee', NEW.assignee, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'done_at', NEW.done_at, 'version', NEW.version);
END;
CREATE TRIGGER backlog_tasks_audit_update AFTER UPDATE ON backlog_tasks BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.workspace_id, COALESCE((SELECT 'B' || seq FROM backlog WHERE id = NEW.item_id), 'T' || NEW.seq), CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog_tasks', json_object('id', OLD.id, 'seq', OLD.seq, 'item_id', OLD.item_id, 'session_id', OLD.session_id, 'goal', OLD.goal, 'reason', OLD.reason, 'result', OLD.result, 'state', OLD.state, 'position', OLD.position, 'assignee', OLD.assignee, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'done_at', OLD.done_at, 'version', OLD.version), json_object('id', NEW.id, 'seq', NEW.seq, 'item_id', NEW.item_id, 'session_id', NEW.session_id, 'goal', NEW.goal, 'reason', NEW.reason, 'result', NEW.result, 'state', NEW.state, 'position', NEW.position, 'assignee', NEW.assignee, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'done_at', NEW.done_at, 'version', NEW.version);
END;
CREATE TRIGGER backlog_tasks_audit_delete AFTER DELETE ON backlog_tasks BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT OLD.workspace_id, COALESCE((SELECT 'B' || seq FROM backlog WHERE id = OLD.item_id), 'T' || OLD.seq), CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_tasks', json_object('id', OLD.id, 'seq', OLD.seq, 'item_id', OLD.item_id, 'session_id', OLD.session_id, 'goal', OLD.goal, 'reason', OLD.reason, 'result', OLD.result, 'state', OLD.state, 'position', OLD.position, 'assignee', OLD.assignee, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'done_at', OLD.done_at, 'version', OLD.version), NULL;
END;
CREATE TRIGGER backlog_tasks_audit_leave AFTER UPDATE OF item_id ON backlog_tasks WHEN OLD.item_id IS NOT NULL AND OLD.item_id IS NOT NEW.item_id BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT OLD.workspace_id, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog_tasks', json_object('id', OLD.id, 'seq', OLD.seq, 'item_id', OLD.item_id, 'session_id', OLD.session_id, 'state', OLD.state, 'version', OLD.version), json_object('id', NEW.id, 'seq', NEW.seq, 'item_id', NEW.item_id, 'session_id', NEW.session_id, 'state', NEW.state, 'version', NEW.version)
 FROM backlog b WHERE b.id = OLD.item_id;
END;

CREATE TABLE workspace_commands (
  id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), backlog_id TEXT,
  action TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, message TEXT NOT NULL,
  PRIMARY KEY(workspace_id, session_id, id));
CREATE INDEX workspace_commands_repo ON workspace_commands(workspace_id, session_id, at);
CREATE TRIGGER workspace_commands_audit_insert AFTER INSERT ON workspace_commands WHEN NEW.backlog_id IS NOT NULL BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, after_value)
 VALUES (NEW.workspace_id, NEW.backlog_id, NEW.at, octocode_audit_actor(), 'insert', 'workspace_commands', json_object('id', NEW.id, 'action', NEW.action, 'input', NEW.input, 'status', NEW.status));
END;
CREATE TRIGGER workspace_commands_audit_update AFTER UPDATE ON workspace_commands WHEN NEW.backlog_id IS NOT NULL BEGIN
 INSERT INTO backlog_audits(workspace_id, backlog_id, at, actor, action, entity, before_value, after_value)
 VALUES (NEW.workspace_id, NEW.backlog_id, NEW.at, octocode_audit_actor(), 'update', 'workspace_commands', json_object('status', OLD.status, 'message', OLD.message), json_object('status', NEW.status, 'message', NEW.message));
END;

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK(scope IN ('global','project','workspace')),
  repo_key TEXT, workspace_id TEXT REFERENCES workspaces(id),
  kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('preference','fact','decision','gotcha','procedure','reference')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, source_session TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
  CHECK ((scope = 'global' AND repo_key IS NULL AND workspace_id IS NULL)
      OR (scope = 'project' AND repo_key IS NOT NULL AND workspace_id IS NULL)
      OR (scope = 'workspace' AND repo_key IS NULL AND workspace_id IS NOT NULL)));
CREATE INDEX memories_scope ON memories(scope, repo_key, updated_at DESC);
CREATE INDEX memories_workspace ON memories(workspace_id, updated_at DESC) WHERE scope = 'workspace';
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE config_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '', before_kind TEXT NOT NULL DEFAULT '', after_kind TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '');
CREATE INDEX config_audits_at ON config_audits(at, id);
CREATE TRIGGER config_audits_immutable_update BEFORE UPDATE ON config_audits BEGIN
 SELECT RAISE(ABORT, 'Audit events are immutable');
END;
CREATE TRIGGER config_audits_immutable_delete BEFORE DELETE ON config_audits BEGIN
 SELECT RAISE(ABORT, 'Audit events are immutable');
END;

CREATE TABLE agents (
  id TEXT PRIMARY KEY, team TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), role TEXT NOT NULL, parent_id TEXT, pid INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle','working')), task TEXT, activity TEXT,
  joined_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, unpriced INTEGER NOT NULL DEFAULT 0, model TEXT, started TEXT, lease_workspace_id TEXT REFERENCES workspaces(id) CHECK(lease_workspace_id <> workspace_id), tmux_pane TEXT, session_id TEXT,
  registration_id TEXT, persist_events INTEGER NOT NULL DEFAULT 0, activation_id TEXT, lifecycle_session_id TEXT, parent_registration_id TEXT, end_hint TEXT,
  cwd TEXT, branch TEXT, process_title TEXT, cache_write INTEGER NOT NULL DEFAULT 0, ${AGENT_MAILBOX_COLUMN});
CREATE INDEX agents_scope ON agents(team, joined_at);
CREATE INDEX agents_workspace ON agents(workspace_id);
CREATE TABLE agent_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES workspaces(id), time TEXT NOT NULL,
  name TEXT, parent_id TEXT, session_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL,
  event_key TEXT UNIQUE);
CREATE INDEX agent_events_workspace ON agent_events(workspace_id, seq DESC);
CREATE INDEX agent_events_agent ON agent_events(workspace_id, name, seq DESC);
CREATE INDEX agent_events_session ON agent_events(workspace_id, session_id, seq DESC);
${AGENT_RUNS_SCHEMA}
${TIMERS_SCHEMA}
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), sender TEXT NOT NULL, body TEXT NOT NULL,
  reply_required INTEGER NOT NULL DEFAULT 1, reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX messages_age ON messages(created_at);
CREATE TABLE deliveries (
  message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, recipient TEXT NOT NULL,
  delivered_at INTEGER, completed_at INTEGER, dead_at INTEGER, wake INTEGER, notified_at INTEGER, proof TEXT,
  forwarded_by TEXT, relay_to TEXT, note TEXT, PRIMARY KEY(message, recipient));
CREATE INDEX deliveries_inbox ON deliveries(recipient, delivered_at);
CREATE INDEX deliveries_unnotified ON deliveries(message) WHERE dead_at IS NOT NULL AND notified_at IS NULL;
CREATE TABLE leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, path_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','tree')), owner TEXT NOT NULL, reason TEXT NOT NULL,
  acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX leases_path ON leases(workspace_id, path_key);
CREATE INDEX leases_owner ON leases(owner);
CREATE TABLE edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX edits_recent ON edits(workspace_id, at);
CREATE TABLE trusted_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
  dev TEXT NOT NULL, ino TEXT NOT NULL, birth TEXT NOT NULL DEFAULT '0',
  decision TEXT NOT NULL DEFAULT 'trusted' CHECK(decision IN ('trusted','refused')),
  scope TEXT NOT NULL CHECK(scope IN ('folder','subtree')),
  source TEXT NOT NULL, surface TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at INTEGER NOT NULL,
  from_path TEXT, revoked_at INTEGER, revoked_by TEXT);
CREATE UNIQUE INDEX trusted_folders_live ON trusted_folders(dev, ino) WHERE revoked_at IS NULL;
CREATE TABLE session_forks (
  child_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  child_file TEXT NOT NULL, CHECK(child_id <> parent_id));
CREATE INDEX session_forks_parent ON session_forks(parent_id);
${ITEM_REVIEWS_SCHEMA}
${SHELL_HISTORY_SCHEMA}
`;

/** Optional full-text index over memories and its synchronization triggers. */
export const FTS = `
CREATE VIRTUAL TABLE memories_fts USING fts5(title, keywords, body, content='memories', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, keywords, body) VALUES (new.id, new.title, new.keywords, new.body);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, keywords, body) VALUES ('delete', old.id, old.title, old.keywords, old.body);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF title, keywords, body ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, keywords, body) VALUES ('delete', old.id, old.title, old.keywords, old.body);
  INSERT INTO memories_fts(rowid, title, keywords, body) VALUES (new.id, new.title, new.keywords, new.body);
END;
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
`;
