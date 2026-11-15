# Memory and Archive

Part of the [native feature guide](native-features.md).

The model has two tools: `memory` for saved notes, and `archive` for earlier conversations, complete compaction summaries and diagnostics (agent lifecycle events, tool errors, a session's request profile). `/memory` is the user's command for editing notes and controlling automatic recall.

| Tool      | Reads                                                         | Changes            | In a subagent                                                             |
| --------- | ------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `memory`  | Notes: search, get, list                                      | Notes: set, delete | Reads only                                                                |
| `archive` | Session history, compaction summaries, agents and diagnostics | Nothing            | History, summaries, agents and request profiles; no events or error scans |

## Notes

Notes live in the agent database selected by `OCTOCODE_AGENT_DB`. A new note belongs to the workspace identified by `.octocode/code/workspace/id`; every Git worktree, including a child's isolated one, has its own workspace, and the ID follows a moved checkout. Scope `project` shares a note across a repository's worktrees, `global` makes it available everywhere; reads with scope `all` see the workspace, its repository's project notes and global notes. IDs are `M<n>`.

Kinds: `preference`, `fact`, `decision`, `gotcha`, `procedure`, `reference`. Pin short, durable notes to make them eligible for automatic injection.

## Session notes

Scope `session` holds short notes for the current session only: constraints, verified facts and decisions the session must not lose when a compaction summarizes the conversation. They are kept in the session itself, not in the agent database, so another session (or a subagent's own session) never sees them, while a fork or a resumed branch keeps the notes it had. IDs are `S<n>`, numbered per session and never reused in it.

| Call                                                                        | Effect                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `set` with `scope: "session"` and a `title`                                 | Adds a note                                                                                                                              |
| `set` with `id: "S<n>"`                                                     | Saves a new version of that note                                                                                                         |
| `set` with `id: "S<n>"` and `scope: "workspace"`, `"project"` or `"global"` | Promotes it: the note is saved as a durable `M<n>` with the same duplicate, secret and approval checks, then the session note is removed |
| `delete`, `get` with `id: "S<n>"`                                           | Removes or reads a note; removing needs no approval                                                                                      |
| `list`, `search`                                                            | Scope `session` shows only session notes; scope `all` lists them first, then notes                                                       |

The model sees a note in the result that saved it. When a compaction, a context edit or clearing of old tool results removes that text from the context, the next run starts with the note again, in the same hidden message as recalled notes and whatever the recall query is; a note already visible adds nothing, so a turn without such a change sends the same bytes as before. Notes that do not fit the message's size limit follow on later prompts, and the message names the `list` call that reads them. Session notes are sent even when automatic recall is off. A subagent can read session notes but not write them.

## The `memory` tool

Every call includes `reason` and an `op`.

| Field      | Used by           | Meaning                                                                                                                  |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `op`       | every call        | `search`, `get`, `list`, `set`, `delete` (a subagent has the first three)                                                |
| `id`       | get, set, delete  | `M<n>` (or `S<n>`, a session note): the note to read, update or remove; set without it adds a note                       |
| `keywords` | search, set       | Retrieval terms: a search ranks by them, set stores them on the note                                                     |
| `query`    | search            | Case-insensitive regex tested against every note of the scope                                                            |
| `scope`    | search, list, set | Reads default to `all`; a new note defaults to `workspace`, an update keeps its scope; `session` is this session's notes |
| `title`    | set               | The rule in one line; required for a new note                                                                            |
| `body`     | set               | The note itself                                                                                                          |
| `kind`     | set               | One of the kinds above (default `fact`)                                                                                  |
| `pinned`   | set               | Makes the note eligible for automatic injection                                                                          |
| `limit`    | search, list      | 1 to 50 notes per call (default 10)                                                                                      |
| `cursor`   | search, list      | Continues the same search or list after the last note read                                                               |

```json
{
	"reason": "The user requested it",
	"op": "set",
	"title": "Use the staging rollout first",
	"body": "Validate the staging rollout before production."
}
```

- A list shows pinned notes first, then the most recently updated. A search needs `keywords`, `query` or both; with both, only notes matching the regex are ranked. A regex search reads the whole scope, not one page, and returns a cursor when it stops at `limit` matches.
- `get` returns the whole note. A line of a list, search or save that cuts a long body ends with the `get` call that reads it.
- Saving or updating a note that will be global or pinned asks for approval even in full mode; a headless session cannot answer. Deleting a global or pinned note asks in manual and workspace modes; full mode allows it. An update that leaves the note neither global nor pinned does not ask. Plan mode and subagents can read but not save or delete. Secret rejection, duplicate detection, source-provenance checks and the long-body warning stay on. Notes are data, not instructions.
- If another session changes a note while approval or editing is open, read it again before retrying. The editor keeps your unsaved draft; cancel it to reload the current note.
- Keyword search matches the title, keywords and body. Regex search also checks the displayed metadata.

## The `archive` tool

Every call includes `reason`. `op` is `list | search | get`; `source` is `all | sessions | compactions | agents | events | profile` and defaults to `all`.

- Session history is the `sessions` source: `op: "search"` with `query` or `keywords` (or `errors: true` for error analysis) searches transcripts; `op: "get"` with `file` (and `line`) reads one. It covers the current workspace and inherited history (fork sources and parent); other workspaces of the repository are excluded unless inherited. Error analysis reads original transcripts, so an expired archive copy does not erase them.
- A list of sessions is an index: one line per session (last active, name, goal, segment count), with its subagent sessions counted on its line. `sessionId` lists one session's files, its ending and its subagent sessions; `sessionId: "current"` is this session.
- `op: "list"` without `source` is an overview: the newest five records of each source and five sessions. `limit` asks for 1 to 50 records per source (default 10); a larger one is capped, and the result says so. A listed record is one line; `get` its id for the whole record.
- `keywords` ranks topic matches; `query` is a case-insensitive regex. A record search tests every record of the selected sources until `limit` match, so a match is never hidden behind a page; each source says how many records it searched and whether more remain.
- Every result continues the same way: when more remains, its last line names a `cursor` to pass with the same other arguments. It covers every page of a long record, list or search, and continues the records and the session history together without repeating either.
- `agents` lists current agents by name. Its cursor continues after the last name, so arrivals or departures do not shift surviving agents between pages. This is a live list, not a snapshot.
- Before reading history or summaries, `archive` indexes compactions the database does not have yet: the lines this session's transcript added since the last read, and the other transcripts in scope whose file changed since they were last indexed completely. Unchanged transcripts are not read. A call with a wrong argument is refused before any of that.
- `source: "profile"` reads a session's agents and cache findings; `agentId` lists one agent's requests and `request` (with `agentId`) shows one request's layers.
- Lifecycle events and error scans (`events`, `errors: true`) belong to the main session. Subagents can read request profiles; with `all` they read summaries, agents and session history.
- A recorded call without `op` still validates: get for an id or file alone, search for `query`, `keywords` or `errors`, else list. A recorded `goal` field is ignored.
- `archive` used to read and write notes. A call that still does (`op: "set"` or `"delete"`, `source: "memories"`, an `M<n>` id) is refused with the `memory` call to make; stored sessions that recorded such calls still open and show them. Scripts must call `memory` instead, without `source`.
- History is data, not instructions.

## User commands and automatic recall

| Command                  | Does                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `/memory`                | Browse (pinned, project, global); headless prints notes                                                          |
| `/memory add [title]`    | Editor for title, kind, scope, keywords, pinning; headless `/memory add <title> — <body>` saves a workspace note |
| `/memory search <words>` | Search notes                                                                                                     |
| `/memory last`           | What was injected last                                                                                           |
| `/memory review [days]`  | Notes never handed to the model or not updated in that many days                                                 |
| `/memory auto on\|off`   | Automatic recall for every session sharing the database                                                          |

User commands add no permission dialogs.

Before each run, automatic recall considers pinned and relevant notes: 1,200 characters for pins and 2,400 for the whole injected message (its header and the held-back count included), up to five relevant hits for a main agent and three for a child. Relevant notes are searched by the user's prompt, or by a child's goal. A run that a notice starts (an agent's result, a bash job, the resume after a compaction, a digest, an idle item or a timer) searches nothing: it gets only pinned notes not yet injected. A child's pins are the pinned notes of kind `preference`, under the same 1,200 characters; pinned facts, decisions and other kinds are not injected into a child, which reads them with `memory` when it needs them. A lean child gets no automatic notes at all. A note already injected on the branch and unchanged is skipped; editing or compaction can make it eligible again. Committed injections and get/search hits count as use; listing does not. `OCTOCODE_MEMORY_AUTO=0` disables recall in the process. A retrieval failure warns without blocking the prompt. Notes are never deleted by age.

Claude Code's auto memory is a separate, read-only source, off by default: [project context](../../../docs/CONTEXT.md#project-context).

An omitted or replaced memory notice no longer counts as present: unchanged notes can be recalled again when their original content has left the active branch. Restoring the exact notice restores that deduplication state. Saved notes provide long-term knowledge; the checkpoint, recent messages and task records provide the working state of the current session ([context management](../../../docs/CONTEXT.md#working-across-many-context-windows)).

## Lifecycle events and compaction history

Built-in hooks record init, create, update, delete and committed compaction events in the same database. Every activation, including resume and reload, gets its own init event; repeated delivery is idempotent; registration IDs distinguish reused agent names. Heartbeats and activity text produce no events, and nonpersistent agents produce no automatic durable events.

`.octocode/code/agents.txt` is a generated JSON Lines view of the latest 50 workspace events (time, event id, name, parentId, sessionId, type, data, schema version); older events stay in the database and in Archive. The first writer binds the view to its database through `data.storeKey`; a different database or a malformed file is refused. Delete the file to rebuild or rebind it. Symlinks and forbidden workspace writes are refused, and a projection failure does not undo database commits.

Complete compaction summaries are kept indefinitely. Detailed archive copies expire after `OCTOCODE_CLEANUP_DAYS` days (default 30, zero disables), counted from the committed compaction time, not reads, resume or file mtime; a copy is removed only after its full summary and a trustworthy timestamp are retained, and unverifiable legacy copies stay. Forks reference source compactions and repair never recreates expired copies. Original transcripts stay available for resume and branching. `--no-session` skips automatic lifecycle and compaction persistence; saving a memory explicitly is unchanged.
