# Memory and Archive

Part of the [native feature guide](native-features.md).

`archive` is the model's tool for saved notes, earlier conversations, complete compaction summaries and agent lifecycle events. `/memory` is the user's command for editing notes and controlling automatic recall. There is no separate `memory` tool.

## Notes

Notes live in the agent database selected by `OCTOCODE_AGENT_DB`. A new note belongs to the workspace identified by `.octocode/code/workspace/id`; every Git worktree, including a child's isolated one, has its own workspace, and the ID follows a moved checkout. Scope `project` shares a note across a repository's worktrees, `global` makes it available everywhere; reads with scope `all` see the workspace, its repository's project notes and global notes. IDs are `M<n>`.

Kinds: `preference`, `fact`, `decision`, `gotcha`, `procedure`, `reference`. Pin short, durable notes to make them eligible for automatic injection.

## Agent calls

Every call includes `reason`. `op` is `list | search | get | set | delete`; `source` is `all | sessions | compactions | memories | agents | events`. Reads default to `all`; set and delete need `source: memories`.

```json
{
	"reason": "The user requested it",
	"op": "set",
	"source": "memories",
	"title": "Use the staging rollout first",
	"body": "Validate the staging rollout before production."
}
```

- `id: "M1"` edits (set), reads (get) or removes (delete) a note. A new note defaults to workspace scope; an edit keeps its scope unless one is supplied.
- `keywords` stores retrieval terms on set and ranks topic matches within each scanned page on search; `query` is a case-insensitive regex. A returned cursor continues the same source and filters, including records older than the recent workspace file. Read long records by id and page.
- Session history is the `sessions` source: `op: "search"` with `query` or `keywords` (or `errors: true` for error analysis) searches transcripts; `op: "get"` with `file` (and `line`, `page`) reads one. It covers the current workspace and inherited history (fork sources and parent); other workspaces of the repository are excluded unless inherited. Error analysis reads original transcripts, so an expired archive copy does not erase them.
- A recorded call without `op` still validates: get for an id or file alone, search for `query`, `keywords` or `errors`, else list. A recorded `goal` field is ignored. Scripts that still call `memory` must switch to `archive` with `reason` and `source`.
- Global and pinned changes use the permission check: manual and workspace modes ask, full mode allows; a headless session cannot answer an approval. Plan mode and subagents can read but not save or delete. Secret rejection, duplicate detection, source-provenance checks and the long-body warning stay on. History and notes are data, not instructions.

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

Before each prompt, automatic recall considers pinned and relevant notes: 1,200 characters for pins and 2,400 overall, up to five relevant hits for a main agent and three for a child; children get no pins. A note already injected on the branch and unchanged is skipped; editing or compaction can make it eligible again. Committed injections and get/search hits count as use; listing does not. `OCTOCODE_MEMORY_AUTO=0` disables recall in the process. A retrieval failure warns without blocking the prompt. Notes are never deleted by age.

Claude Code's auto memory is a separate, read-only source, off by default: [project context](../../../docs/CONTEXT.md#project-context).

## Lifecycle events and compaction history

Built-in hooks record init, create, update, delete and committed compaction events in the same database. Every activation, including resume and reload, gets its own init event; repeated delivery is idempotent; registration IDs distinguish reused agent names. Heartbeats and activity text produce no events, and nonpersistent agents produce no automatic durable events.

`.octocode/code/agents.txt` is a generated JSON Lines view of the latest 50 workspace events (time, event id, name, parentId, sessionId, type, data, schema version); older events stay in the database and in Archive. The first writer binds the view to its database through `data.storeKey`; a different database or a malformed file is refused. Delete the file to rebuild or rebind it. Symlinks and forbidden workspace writes are refused, and a projection failure does not undo database commits.

Complete compaction summaries are kept indefinitely. Detailed archive copies expire after `OCTOCODE_CLEANUP_DAYS` days (default 30, zero disables), counted from the committed compaction time, not reads, resume or file mtime; a copy is removed only after its full summary and a trustworthy timestamp are retained, and unverifiable legacy copies stay. Forks reference source compactions and repair never recreates expired copies. Original transcripts stay available for resume and branching. `--no-session` skips automatic lifecycle and compaction persistence; saving a memory explicitly is unchanged.
