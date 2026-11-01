// The agent database schema as SQL; `schema.ts` reconciles a file against it (see its header for the rules).

/**
 * Sessions (`pid_started`: the process start time, so a reused pid is not taken for the session; `unpriced`: part of
 * its usage came from a model without pricing; `dir`: the session dir it last ran from, null in older rows; the catalog
 * columns `title` (the session's name, null when unnamed) to `file_mtime` cache what the transcript at `file` says so a
 * listing need not parse it: `title_source` is `user`, `auto` or `goal`, `first_prompt` is at most 200 characters, `last_active`
 * is the listing's modified time and `file_mtime` the file's own modification time when the row was written: a file
 * modified since is parsed again; all null before a session's first write), the backlog (`goal`: what done means; `started_at`: when it was last
 * claimed; `from_item`: the row id of the item it came from, cleared by the store when that item is removed;
 * `paths` and `evidence`: one entry per line, so a substring search over the column finds a path or a fact, and
 * `why` and `plan`: free text; `type`: epic, feature, bug or research) and its tasks (`backlog_tasks`: a small step under
 * one item (`item_id`) or, with no item, one session (`session_id`), never both; `position` orders a owner's tasks; the
 * `T<seq>` numbers come from the `meta` high-water mark `backlog_task_seq:<repo>`, so a number is never reused; the
 * audit triggers write each change to `backlog_audits` under the item's number, or `T<seq>` for a session task) and its
 * notes (`kind`: the agent's text or the change log the store writes on every update), the web configuration page's
 * audit (`config_audits`: one append-only row per credential change, naming the provider and the kind of source before
 * and after, never a key, reference or any text from `auth.json`; it, `backlog_audits` and `workspace_commands` lose
 * rows older than 14 days to the history archive, `backlog/retention.ts`), memories (`extended_kind`: a kind newer than the
 * CHECK on `kind`, such as `reference`, with `kind` set to `fact` for older builds; a CHECK cannot change in place) and the team tables
 * (`agents.cache_read`: prompt tokens read from cache; `agents.started`: the start time of the process `pid` names, so
 * heartbeats and liveness tell it from a later process that got the same pid; `agents.workspace`, `messages.workspace`: the
 * team, the git common dir shared by every worktree of a repository (older builds wrote the worktree root), while
 * `leases.workspace` and `edits.workspace` stay the worktree root; `agents.checkout`: the worktree root the agent works
 * in, null in older rows; `agents.tmux_pane`: the tmux pane id (`%12`) a main session runs in, null outside tmux; `agents.session_id`: the id of the session a main agent runs, null for a
 * subagent (its session id is its name) and in older rows, so a session row names its agent only through a live row;
 * `deliveries.proof`: the signature that
 * lets a subagent verify a message the user typed, see `team/proof.ts`; `deliveries.forwarded_by`: the agent that
 * forwarded the stored message to this recipient; `deliveries.relay_to`: a child's message to an agent it cannot reach,
 * held for its parent process to resume that agent with it; `deliveries.note`: the forwarder's note, or why a relay
 * failed; see `team/store/refs.ts`).
 */
export const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, branch TEXT, head TEXT,
  cost REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, files_changed INTEGER NOT NULL DEFAULT 0, pid INTEGER,
  pid_started TEXT, unpriced INTEGER NOT NULL DEFAULT 0, dir TEXT,
  title TEXT, title_source TEXT, cwd TEXT, file TEXT, parent_file TEXT, created_at INTEGER, last_active INTEGER,
  message_count INTEGER, first_prompt TEXT, file_mtime INTEGER);
CREATE INDEX sessions_catalog ON sessions(cwd) WHERE file IS NOT NULL;

CREATE TABLE backlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_key TEXT NOT NULL, seq INTEGER NOT NULL,
  title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  paths TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('backlog','todo','ongoing','done')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3), tags TEXT NOT NULL DEFAULT '',
  assignee TEXT, created_by TEXT NOT NULL, source_session TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, done_at INTEGER,
  from_item INTEGER, version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'feature', parent_id INTEGER,
  UNIQUE(repo_key, seq));
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
CREATE INDEX backlog_board ON backlog(repo_key, state, priority, updated_at);
CREATE INDEX backlog_from ON backlog(from_item) WHERE from_item IS NOT NULL;
CREATE INDEX backlog_assignee ON backlog(assignee, state) WHERE assignee IS NOT NULL;
CREATE INDEX backlog_seq ON backlog(seq);
CREATE TABLE backlog_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL REFERENCES backlog(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','change')), text TEXT NOT NULL);
CREATE INDEX backlog_notes_item ON backlog_notes(item, at);

CREATE TABLE backlog_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL REFERENCES backlog(id) ON DELETE CASCADE,
  legacy_note_id INTEGER UNIQUE, at INTEGER NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX backlog_comments_item ON backlog_comments(item, id);
CREATE TABLE backlog_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_key TEXT NOT NULL, backlog_id TEXT NOT NULL,
  at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
  before_value TEXT, after_value TEXT);
CREATE INDEX backlog_audits_item ON backlog_audits(repo_key, backlog_id, id);
CREATE TRIGGER backlog_audits_immutable_update BEFORE UPDATE ON backlog_audits BEGIN
 SELECT RAISE(ABORT, 'Audit events are immutable');
END;
CREATE TRIGGER backlog_audits_immutable_delete BEFORE DELETE ON backlog_audits BEGIN
 SELECT RAISE(ABORT, 'Audit events are immutable');
END;
CREATE TRIGGER backlog_audits_skip_noop BEFORE INSERT ON backlog_audits WHEN NEW.action = 'update' AND json_remove(json_set(NEW.before_value, '$.type', CASE json_extract(NEW.before_value, '$.type') WHEN 'task' THEN 'feature' ELSE json_extract(NEW.before_value, '$.type') END), '$.updated_at', '$.version') IS json_remove(json_set(NEW.after_value, '$.type', CASE json_extract(NEW.after_value, '$.type') WHEN 'task' THEN 'feature' ELSE json_extract(NEW.after_value, '$.type') END), '$.updated_at', '$.version') BEGIN
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
 INSERT INTO backlog_comments(item, legacy_note_id, at, author, text) VALUES (NEW.item, NEW.id, NEW.at, NEW.author, NEW.text);
END;
CREATE TRIGGER backlog_audits_insert AFTER INSERT ON backlog BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.repo_key, 'B' || NEW.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog', NULL, json_object('id', NEW.id, 'repo_key', NEW.repo_key, 'seq', NEW.seq, 'title', NEW.title, 'goal', NEW.goal, 'body', NEW.body, 'paths', NEW.paths, 'why', NEW.why, 'evidence', NEW.evidence, 'plan', NEW.plan, 'state', NEW.state, 'priority', NEW.priority, 'tags', NEW.tags, 'assignee', NEW.assignee, 'created_by', NEW.created_by, 'source_session', NEW.source_session, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'started_at', NEW.started_at, 'done_at', NEW.done_at, 'from_item', NEW.from_item, 'version', NEW.version, 'type', NEW.type, 'parent_id', NEW.parent_id);
END;
CREATE TRIGGER backlog_audits_update AFTER UPDATE ON backlog BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.repo_key, 'B' || NEW.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog', json_object('id', OLD.id, 'repo_key', OLD.repo_key, 'seq', OLD.seq, 'title', OLD.title, 'goal', OLD.goal, 'body', OLD.body, 'paths', OLD.paths, 'why', OLD.why, 'evidence', OLD.evidence, 'plan', OLD.plan, 'state', OLD.state, 'priority', OLD.priority, 'tags', OLD.tags, 'assignee', OLD.assignee, 'created_by', OLD.created_by, 'source_session', OLD.source_session, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'started_at', OLD.started_at, 'done_at', OLD.done_at, 'from_item', OLD.from_item, 'version', OLD.version, 'type', OLD.type, 'parent_id', OLD.parent_id), json_object('id', NEW.id, 'repo_key', NEW.repo_key, 'seq', NEW.seq, 'title', NEW.title, 'goal', NEW.goal, 'body', NEW.body, 'paths', NEW.paths, 'why', NEW.why, 'evidence', NEW.evidence, 'plan', NEW.plan, 'state', NEW.state, 'priority', NEW.priority, 'tags', NEW.tags, 'assignee', NEW.assignee, 'created_by', NEW.created_by, 'source_session', NEW.source_session, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'started_at', NEW.started_at, 'done_at', NEW.done_at, 'from_item', NEW.from_item, 'version', NEW.version, 'type', NEW.type, 'parent_id', NEW.parent_id);
END;
CREATE TRIGGER backlog_audits_delete AFTER DELETE ON backlog BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT OLD.repo_key, 'B' || OLD.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog', json_object('id', OLD.id, 'repo_key', OLD.repo_key, 'seq', OLD.seq, 'title', OLD.title, 'goal', OLD.goal, 'body', OLD.body, 'paths', OLD.paths, 'why', OLD.why, 'evidence', OLD.evidence, 'plan', OLD.plan, 'state', OLD.state, 'priority', OLD.priority, 'tags', OLD.tags, 'assignee', OLD.assignee, 'created_by', OLD.created_by, 'source_session', OLD.source_session, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'started_at', OLD.started_at, 'done_at', OLD.done_at, 'from_item', OLD.from_item, 'version', OLD.version, 'type', OLD.type, 'parent_id', OLD.parent_id), NULL;
END;
CREATE TRIGGER backlog_links_audit_insert AFTER INSERT ON backlog_links BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_links', NULL, json_object('item', NEW.item, 'relation', NEW.relation, 'target', NEW.target) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_links_audit_update AFTER UPDATE ON backlog_links BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog_links', json_object('item', OLD.item, 'relation', OLD.relation, 'target', OLD.target), json_object('item', NEW.item, 'relation', NEW.relation, 'target', NEW.target) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_links_audit_delete AFTER DELETE ON backlog_links BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_links', json_object('item', OLD.item, 'relation', OLD.relation, 'target', OLD.target), NULL FROM backlog b WHERE b.id = OLD.item;
END;
CREATE TRIGGER backlog_completions_audit_insert AFTER INSERT ON backlog_completions BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_completions', NULL, json_object('id', NEW.id, 'item', NEW.item, 'operation_key', NEW.operation_key, 'payload', NEW.payload) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_completions_audit_delete AFTER DELETE ON backlog_completions BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_completions', json_object('id', OLD.id, 'item', OLD.item, 'operation_key', OLD.operation_key, 'payload', OLD.payload), NULL FROM backlog b WHERE b.id = OLD.item;
END;
CREATE TRIGGER backlog_comments_audit_insert AFTER INSERT ON backlog_comments BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_comments', NULL, json_object('id', NEW.id, 'item', NEW.item, 'at', NEW.at, 'author', NEW.author, 'text', NEW.text) FROM backlog b WHERE b.id = NEW.item;
END;
CREATE TRIGGER backlog_comments_audit_delete AFTER DELETE ON backlog_comments BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT b.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_comments', json_object('id', OLD.id, 'item', OLD.item, 'at', OLD.at, 'author', OLD.author, 'text', OLD.text), NULL FROM backlog b WHERE b.id = OLD.item;
END;

CREATE TABLE backlog_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_key TEXT NOT NULL, seq INTEGER NOT NULL,
  item_id INTEGER REFERENCES backlog(id) ON DELETE CASCADE, session_id TEXT,
  goal TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','ongoing','done','dropped')),
  position INTEGER NOT NULL DEFAULT 0, assignee TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(repo_key, seq),
  CHECK((item_id IS NULL) <> (session_id IS NULL)));
CREATE INDEX backlog_tasks_item ON backlog_tasks(item_id, position, id) WHERE item_id IS NOT NULL;
CREATE INDEX backlog_tasks_session ON backlog_tasks(repo_key, session_id, position, id) WHERE session_id IS NOT NULL;
CREATE INDEX backlog_tasks_state ON backlog_tasks(repo_key, state);
CREATE TRIGGER backlog_tasks_audit_insert AFTER INSERT ON backlog_tasks BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.repo_key, COALESCE((SELECT 'B' || seq FROM backlog WHERE id = NEW.item_id), 'T' || NEW.seq), CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'insert', 'backlog_tasks', NULL, json_object('id', NEW.id, 'seq', NEW.seq, 'item_id', NEW.item_id, 'session_id', NEW.session_id, 'goal', NEW.goal, 'reason', NEW.reason, 'result', NEW.result, 'state', NEW.state, 'position', NEW.position, 'assignee', NEW.assignee, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'done_at', NEW.done_at, 'version', NEW.version);
END;
CREATE TRIGGER backlog_tasks_audit_update AFTER UPDATE ON backlog_tasks BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT NEW.repo_key, COALESCE((SELECT 'B' || seq FROM backlog WHERE id = NEW.item_id), 'T' || NEW.seq), CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog_tasks', json_object('id', OLD.id, 'seq', OLD.seq, 'item_id', OLD.item_id, 'session_id', OLD.session_id, 'goal', OLD.goal, 'reason', OLD.reason, 'result', OLD.result, 'state', OLD.state, 'position', OLD.position, 'assignee', OLD.assignee, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'done_at', OLD.done_at, 'version', OLD.version), json_object('id', NEW.id, 'seq', NEW.seq, 'item_id', NEW.item_id, 'session_id', NEW.session_id, 'goal', NEW.goal, 'reason', NEW.reason, 'result', NEW.result, 'state', NEW.state, 'position', NEW.position, 'assignee', NEW.assignee, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'done_at', NEW.done_at, 'version', NEW.version);
END;
CREATE TRIGGER backlog_tasks_audit_delete AFTER DELETE ON backlog_tasks BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT OLD.repo_key, COALESCE((SELECT 'B' || seq FROM backlog WHERE id = OLD.item_id), 'T' || OLD.seq), CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'delete', 'backlog_tasks', json_object('id', OLD.id, 'seq', OLD.seq, 'item_id', OLD.item_id, 'session_id', OLD.session_id, 'goal', OLD.goal, 'reason', OLD.reason, 'result', OLD.result, 'state', OLD.state, 'position', OLD.position, 'assignee', OLD.assignee, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'done_at', OLD.done_at, 'version', OLD.version), NULL;
END;
CREATE TRIGGER backlog_tasks_audit_leave AFTER UPDATE OF item_id ON backlog_tasks WHEN OLD.item_id IS NOT NULL AND OLD.item_id IS NOT NEW.item_id BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 SELECT OLD.repo_key, 'B' || b.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER), octocode_audit_actor(), 'update', 'backlog_tasks', json_object('id', OLD.id, 'seq', OLD.seq, 'item_id', OLD.item_id, 'session_id', OLD.session_id, 'state', OLD.state, 'version', OLD.version), json_object('id', NEW.id, 'seq', NEW.seq, 'item_id', NEW.item_id, 'session_id', NEW.session_id, 'state', NEW.state, 'version', NEW.version)
 FROM backlog b WHERE b.id = OLD.item_id;
END;

CREATE TABLE workspace_commands (
  id TEXT NOT NULL, session_id TEXT NOT NULL, repo_key TEXT NOT NULL, backlog_id TEXT,
  action TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, message TEXT NOT NULL,
  PRIMARY KEY(repo_key, session_id, id));
CREATE INDEX workspace_commands_repo ON workspace_commands(repo_key, session_id, at);
CREATE TRIGGER workspace_commands_audit_insert AFTER INSERT ON workspace_commands WHEN NEW.backlog_id IS NOT NULL BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, after_value)
 VALUES (NEW.repo_key, NEW.backlog_id, NEW.at, octocode_audit_actor(), 'insert', 'workspace_commands', json_object('id', NEW.id, 'action', NEW.action, 'input', NEW.input, 'status', NEW.status));
END;
CREATE TRIGGER workspace_commands_audit_update AFTER UPDATE ON workspace_commands WHEN NEW.backlog_id IS NOT NULL BEGIN
 INSERT INTO backlog_audits(repo_key, backlog_id, at, actor, action, entity, before_value, after_value)
 VALUES (NEW.repo_key, NEW.backlog_id, NEW.at, octocode_audit_actor(), 'update', 'workspace_commands', json_object('status', OLD.status, 'message', OLD.message), json_object('status', NEW.status, 'message', NEW.message));
END;

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK(scope IN ('global','project')),
  repo_key TEXT,
  kind TEXT NOT NULL DEFAULT 'fact' CHECK(kind IN ('preference','fact','decision','gotcha','procedure')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, source_session TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
  extended_kind TEXT);
CREATE INDEX memories_scope ON memories(scope, repo_key, updated_at DESC);
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
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL, role TEXT NOT NULL, parent_id TEXT, pid INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle','working')), task TEXT, activity TEXT,
  joined_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, unpriced INTEGER NOT NULL DEFAULT 0, model TEXT, started TEXT, checkout TEXT, tmux_pane TEXT, session_id TEXT);
CREATE INDEX agents_scope ON agents(workspace, joined_at);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','tree')), owner TEXT NOT NULL, reason TEXT NOT NULL,
  acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX leases_path ON leases(workspace, path_key);
CREATE INDEX leases_owner ON leases(owner);
CREATE TABLE edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, path TEXT NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX edits_recent ON edits(workspace, at);
`;

/** The optional full-text index over memories: its table and triggers, owned by `ensureFts`, not by the reconcile. */
export const FTS_OBJECTS = /^memories_fts(?:_|$)/;

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
