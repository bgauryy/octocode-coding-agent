# Session storage formats

Read this when a session is missing from `list`, the script prints a note, or a tool changed its layout. None of these formats is a public contract; the paths below are what the script reads.

## Claude Code

- Folder: `$CLAUDE_CONFIG_DIR` or `~/.claude`; sessions in `projects/<directory>/<session-id>.jsonl`, where `<directory>` is the working directory with every character other than a letter or digit replaced by `-` (`/Users/me/repo` becomes `-Users-me-repo`).
- Records: `user` and `assistant` lines with `cwd`, `gitBranch`, `timestamp` and `message.content` (text, `tool_use`, `tool_result`, `thinking` blocks); `ai-title` or `custom-title` lines name the session. `isSidechain` lines and `<session>/subagents/` files are subagents and are skipped. A user line starting "This session is being continued from a previous conversation" is a compaction summary.
- Resume: `claude --resume <id>` from the session's directory; `claude --continue` takes the newest there. Headless: `claude -p --resume <id> "<prompt>"`.

## Codex

- Folder: `$CODEX_HOME` or `~/.codex`; rollouts in `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, some compressed as `.jsonl.zst`; archived ones in `archived_sessions/`; names in `session_index.jsonl` (`id`, `thread_name`).
- Records: the first line is `session_meta` with `id`, `cwd`, `timestamp` and `git`. Then `response_item` lines (`message` with role `user`, `assistant` or `developer`; `function_call`, `custom_tool_call` such as `apply_patch`, `local_shell_call`), `event_msg` lines that repeat them for the UI, and `compacted` lines whose `message` is a summary. User messages starting with `<environment_context>`, `# AGENTS.md instructions` and similar tags are injected context and are skipped. Sessions Codex imported from Claude Code keep Claude's notices, also skipped; `external_agent_session_imports.json` maps such a thread to its source transcript, which the listing shows as `imported from <file>` (the original usually appears too, with the real timing).
- Resume: `codex resume <id>` (`--last` for the newest, `--all` to show other directories); headless `codex exec resume <id> "<prompt>"`.

## Cursor

Three stores; one chat can appear in more than one under the same id, and the script keeps the fullest record.

- Agent transcripts: `~/.cursor/projects/<path slug>/agent-transcripts/<id>.jsonl` (or `<id>/<id>.jsonl`, older `<id>.txt`), lines `{ role, message: { content } }`; the typed prompt is wrapped in `<user_query>`. A transcript records no directory, so the folder name must spell the repository or worktree path exactly.
- CLI agent chats: `~/.cursor/chats/<md5 of the workspace path>/<chat id>/store.db` with tables `meta` (hex-encoded JSON: `name`, `createdAt`, `mode`) and `blobs` (JSON messages mixed with binary tree nodes; their stored order approximates the conversation). Resume: `cursor-agent --resume <chat id>`; newer installs call the CLI `agent` (check `command -v`, other tools also install an `agent`).
- Editor chats: app data `~/Library/Application Support/Cursor/User` (macOS), `~/.config/Cursor/User` (Linux), `%APPDATA%\Cursor\User` (Windows). `workspaceStorage/<id>/workspace.json` names the folder; `globalStorage/state.vscdb` holds `composer.composerHeaders` in `ItemTable` (chat list with `workspaceIdentifier`) and, in `cursorDiskKV`, `composerData:<chat id>` (`fullConversationHeadersOnly`) and `bubbleId:<chat id>:<bubble id>` (type 1 user, 2 assistant, `text`, `toolFormerData`). Older versions list chats in the workspace's own `state.vscdb` under `composer.composerData`. These chats have no command-line resume.
- The databases are read with `sqlite3 -readonly` on an `immutable=1` URI, so a running Cursor is neither locked nor changed.

## Worktrees

Scopes are the repository root plus every entry of `git worktree list --porcelain`, including entries whose folder is gone. Folders under `<repo>/.claude/worktrees/`, `<repo>/.octocode/agent/worktrees/`, `~/.cursor/worktrees/<repo name>/` and `~/.codex/worktrees/` whose `.git` file points into this repository's `worktrees/` metadata but that git no longer lists are reported as unregistered. Ahead and behind counts compare with `origin/HEAD`, else `main` or `master`, else the root's branch.
