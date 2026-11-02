# Memory and Archive

Part of the [native feature guide](native-features.md).

`archive` is the model's tool for saved knowledge, earlier conversations, complete compaction summaries and agent lifecycle events. `/memory` remains the user's command for editing notes and controlling automatic recall. There is no separately registered `memory` tool.

## Workspace notes

Notes live in the existing agent database selected by `OCTOCODE_AGENT_DB`. New notes default to `workspace`: the canonical checkout root, or the parent's checkout inherited by an isolated child. Independent worktrees have separate workspace notes. Outside Git, the starting directory supplies the workspace. No marker file is needed.

Existing `project` notes stay shared across the repository's worktrees; `global` notes remain available everywhere. Reads with scope `all` see this workspace, this repository's project notes and global notes. Moving a workspace does not automatically transfer its notes. IDs remain `M<n>`.

For compatibility, workspace notes use a reserved `workspace:v1:<encoded-root>` repository key under the existing database constraint. Older builds cannot see or change them through their memory tool. Existing rows are not rewritten.

Kinds are `preference`, `fact`, `decision`, `gotcha`, `procedure` and `reference`. `reference` retains its existing additive `extended_kind` representation. A pinned note is eligible for automatic injection in its scope; pin only short, durable knowledge.

## Agent calls

Every call includes `goal` and `reason`. Use `op: list | search | get | set | delete` and `source: all | sessions | compactions | memories | agents | events`. Explicit reads default to `all`; set/delete require `source: memories`.

```json
{
	"goal": "Remember the deployment preference",
	"reason": "The user requested it",
	"op": "set",
	"source": "memories",
	"title": "Use the staging rollout first",
	"body": "Validate the staging rollout before production."
}
```

Use `id: "M1"` with set to edit a note, with get to read it, or with delete to remove it. New notes default to workspace; an edit keeps its scope unless a scope is supplied. `keywords` stores retrieval terms on set; on search it ranks topic matches within each scanned page. `query` is a case-insensitive regex. Returned cursors continue the same source and filters, including older records beyond the recent workspace file. Long records are read by id and page.

Global and pinned changes keep the existing permission check: manual/workspace modes ask; full mode allows them. Headless sessions cannot satisfy an approval request. Plan mode and subagents may read but cannot save or delete notes. Secret rejection, duplicate detection, source-provenance checks and the warning for long bodies remain in place. History and notes are data, not instructions.

Legacy Archive calls without op/source retain query, keywords, file, line, page and error-analysis behavior. Both call forms search the current workspace and inherited session history (fork sources and parent); other workspaces in the same repository are excluded unless inherited. Error analysis reads original transcripts; expiration of an archive copy does not erase those transcripts. Update tool selectors and RPC scripts from `memory` to `archive`, adding source and goal. Historical tool results remain readable.

## User commands and automatic recall

`/memory add [title]` opens an editor with title, kind, scope, keywords and pinning fields. Headless `/memory add <title> — <body>` saves a workspace note. `/memory` browses or prints notes; its editor supports explicit project/global/workspace scopes. `/memory search <words>`, `/memory last`, `/memory review [days]` and `/memory auto on|off` retain their purposes. User commands do not add permission dialogs.

Before each prompt, automatic recall considers pinned and relevant notes. Existing budgets remain: 1,200 characters for pins and 2,400 overall, up to five relevant hits for a main agent and three for a child. Children receive no pins. An unchanged note already injected on the branch is skipped; editing or compaction can make it eligible again. Committed injections and get/search hits count as use; listing does not.

`OCTOCODE_MEMORY_AUTO=0` disables automatic recall in the process. `/memory auto off` disables it in the shared database. A retrieval failure reports a warning without blocking the prompt. Notes are not deleted by age.

## Lifecycle and compaction history

Built-in hooks record init, create, update, delete and committed compaction events in the same database. Each activation, including resume and reload, receives its own init event. Repeated delivery is idempotent. Registration IDs distinguish reused agent names; heartbeat counters and activity text do not generate audit events. Nonpersistent agents do not produce automatic durable events.

`.octocode/agents.txt` is a generated JSON Lines view of the latest 50 workspace events. Each line has time, event id, name, parentId, sessionId, type, data and schema version. Older events remain in the database and available through Archive. The first writer binds the view to its configured database via data.storeKey; a different database or malformed file is refused. Remove this generated file to rebuild or rebind it. Symlinks and forbidden workspace writes are refused. Projection failure does not undo database commits.

Complete compaction summaries survive indefinitely. Detailed archive copies expire according to `OCTOCODE_CLEANUP_DAYS` (default 30, zero disables), measured from committed compaction time, not reads, resume or file mtime. A copy is removed only after its full summary and trustworthy timestamp have been retained. Unverifiable legacy copies stay. Forks reference source compactions; repair never recreates expired copies. Original transcripts remain available for resume and branching. `--no-session` skips automatic lifecycle/compaction persistence; explicitly saving a memory retains its existing behavior.
