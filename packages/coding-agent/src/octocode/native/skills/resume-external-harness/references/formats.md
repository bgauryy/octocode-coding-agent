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

## Antigravity CLI (agy)

- Folder: `~/.gemini/antigravity-cli/`. `conversation_summaries.db` lists every conversation in `conversation_summaries` (`conversation_id`, `title`, `workspace_uris` as a JSON array of `file://` URIs, `last_modified_time`, `last_user_input_time`, `status`); rows with a `parent_conversation_id` are subagents and are skipped. Its `conversations_fts` table holds the text in chunks (`chunk_index` -1 is metadata): `user_body` and `agent_body` with `user_step_byte_offsets` and `agent_step_byte_offsets`, `[step, byte offset]` pairs into the UTF-8 body. It has no tool calls, so it is only the fallback for a conversation without a transcript.
- `history.jsonl`: one line per prompt (`display`, `timestamp` in ms, `workspace`, `conversationId`); slash commands are skipped. The index lags the conversation, so prompts it does not hold yet are appended as the last turns, without their replies.
- `brain/<id>/.system_generated/logs/transcript.jsonl`: one line per step (`step_index`, `type`, `source`, `status`, `created_at`, `content`). `USER_INPUT` is a typed prompt (`content` wraps it in `<USER_REQUEST>`, followed by metadata blocks); `PLANNER_RESPONSE` is a model step whose `tool_calls` (`name`, `args`, values often JSON-quoted strings) are the tools and whose `content` is `null` unless the model wrote text; `GENERIC` steps with source `MODEL` are tool results and `SYSTEM_MESSAGE` is injected context, both skipped. `show` reads turns, tools and the last assistant text from here.
- `conversations/<id>.db`, table `steps` (`idx`, `step_type`, `status`, `error_details`, `step_payload` protobuf blobs; its creation time bounds the start). When the last step has `step_type` 17 or a non-empty `error_details`, the run ended on an error: `show` prints the readable line of its payload (for example `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 50m6s`), since that is why it stopped. Other steps are not read. `cache/last_conversations.json` maps a workspace path to its latest conversation id and is not read; `presence/<id>.lock` is a lock file.
- `show agy:<id>` takes an exact id from any workspace, not only this repository and its worktrees; it prints the workspace the conversation ran in. `list` stays scoped to the repository.
- Resume: `agy --conversation <id>` (aliases `-r`, `--resume`) from the session's workspace; `agy --continue` takes the most recent.

## Octocode

- Folder: `<workspace>/.octocode/agent/sessions/<time>_<id>.jsonl`, where the workspace is the repository root or a worktree (each worktree has its own folder). Neighbouring `.checkpoint-*.md` and `.paid-summary.json` files are not sessions.
- Records: the first line is the `session` header (`id`, `cwd`, `timestamp`); `session_info` names the session; `message` lines carry `role` `user` (typed prompts, prefixed with a `[src …] tN` source tag the script strips), `assistant` (`text` and `toolCall` blocks with `name` and `arguments`; `file` calls list edited paths in `queries` or `patch`) and `toolResult`; `compaction` lines hold a `summary`. `custom` and `custom_message` lines are injected context and are skipped. Entries form a tree (`parentId`); the script reads them in file order, so abandoned branches show too.
- Resume: `octocode --resume <id>` (same as `--session <id>`) from the session's workspace; from another folder Octocode offers to fork it there (headless runs refuse). Inside Octocode, `/resume` picks from a list. `OCTOCODE_SESSION_ID` names the running session, shown as `[this session]`.

## Worktrees

Scopes are the repository root plus every entry of `git worktree list --porcelain`, including entries whose folder is gone. Folders under `<repo>/.claude/worktrees/`, `<repo>/.octocode/agent/worktrees/`, `~/.cursor/worktrees/<repo name>/` and `~/.codex/worktrees/` whose `.git` file points into this repository's `worktrees/` metadata but that git no longer lists are reported as unregistered. Ahead and behind counts compare with `origin/HEAD`, else `main` or `master`, else the root's branch.
