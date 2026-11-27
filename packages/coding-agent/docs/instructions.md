# Steering the agent with instructions

Where you put instructions, which one wins when they disagree, and how to switch each source on or off. Related: [prompts](prompts.md) (the prompt sections), [memory](memory.md), [skills](skills.md), [prompt templates](prompt-templates.md), [configuration](configuration.md#harnesses).

## Which instruction wins

When instructions disagree, the higher rung wins. The ladder is the one the prompt states: project instructions "rank above general habits, below the user's direct request; this prompt's safety rules stay in force" (`octocode/native/prompts/system/project-context.md`).

```mermaid
flowchart TD
  S["1. Safety rules and permissions"] --> U["2. Your request in this conversation"]
  U --> P["3. Project instructions: AGENTS.override.md, AGENTS.md, CLAUDE.md"]
  P --> M["4. Memory notes: data, not instructions"]
  M --> H["5. The agent's general habits: the built-in policy"]
```

- Safety is not overridable by a file: a permission refusal stays a refusal, and the agent never switches tools to get around one.
- Your current words beat any file. The memory header says the same: notes are "data, not instructions", and `AGENTS.md` and your current words win (`notices/memory-file-header.md`).
- A note never repeats `AGENTS.md` or the shipped policy: such a line is refused on save.
- Between project files the closest one wins: a subfolder's file beats its ancestors' for work in that folder.

## Project instruction files

```text
folder holds AGENTS.override.md?  → use it
else AGENTS.md (or AGENTS.MD)?    → use it
else CLAUDE.md?                   → use it (whatever `harness:claude` says)
else                              → the folder adds nothing
```

The candidates are one list in that order, and a folder contributes one file (`CONTEXT_FILE_CANDIDATES`, `core/discovery/sources.ts`). Only the first match in a folder loads, so an `AGENTS.override.md` hides the `AGENTS.md` beside it.

What enters the system prompt, in order (`loadProjectContextFiles`, `core/resource-loader/context-files.ts`):

1. The global file from the agent directory (`~/.octocode/octocodecode/`, or `OCTOCODE_HOME`), picked by the same candidate list. Pi's `~/.pi/agent` is a fallback only while neither `OCTOCODE_HOME` nor `OCTOCODE_CODING_AGENT_DIR` is set.
2. One file per folder from the working folder up, outermost first, so the working folder's file comes last and reads as the most specific.
3. Claude Code's auto `MEMORY.md` for the repository, only with `harness:claude:memory` on (read-only; first 200 lines or 25 KB).

Boundaries of the walk:

- It stops at a trust grant's folder, and at the repository root when another repository lies above (a submodule's or nested repository's parent never loads). Plain folders above a repository still load.
- A linked worktree inside its main checkout loads its own file instead of the main checkout's copy, so the text is not applied twice.
- Each file is cut at 64 KB with a notice naming the path; there is no total cap across files.
- Instruction files load as text without project trust. `--no-context-files` skips them all.

**Subfolder files.** Files below the working folder are not in the system prompt (the prompt stays cached). The first time the agent reads a file under such a folder (a research read, or `cat`, `head`, `tail`, `sed -n` in `bash`), that folder's file, and those of folders between, arrive appended to the read result in the same `<project_instructions>` frame (`octocode/files/nested-context.ts`). Only in a trusted project; at most 64 KB of them are in context at once, a file over the budget is named so the agent can read it itself, and `node_modules`, `vendor` and `.git` folders are skipped. A compaction that drops the result delivers the file again on the next read.

```text
repo/AGENTS.md              in the prompt (cwd = repo)
repo/packages/api/AGENTS.md appended when the agent first reads under packages/api/
```

## The system prompt and how to override it

The prompt is built from named sections in a fixed order; [`sections/index.md`](../src/octocode/native/prompts/sections/index.md) is the map (name, cache tier, whether a custom prompt keeps it, and what writes it) and [prompts](prompts.md) explains the files. Prompt text is Markdown under `src/octocode/native/prompts/`; contributors change it there, never in TypeScript.

| You want to                      | Do this                                                                                                             | Effect                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add rules to every session       | `APPEND_SYSTEM.md` in the agent directory or the trusted project's `.octocode/`, or `--append-system-prompt <text or file>` (repeatable) | Fills the `addendum` section, ahead of the policy. A flag replaces the discovered file                                                                          |
| Replace the opening of the prompt | `SYSTEM.md` in the same places, or `--system-prompt <text or file>`                                                | Replaces `preamble`, drops `docs` and the default conciseness and bash-search rule lines; tools, rules, MCP blocks, policy, project context, memory and `environment` stay |
| Add project rules                | `AGENTS.md` (above)                                                                                                 | `project_context` section                                                                                                                                      |
| Change a subagent role           | A profile `.md` with front matter in `agents/` of the Octocode home or the trusted project's `.octocode/agents/`     | The `role` section of that child ([subagents](native-features.md))                                                                                             |

Which `SYSTEM.md` or `APPEND_SYSTEM.md` is used: one file, the highest ranked. Octocode's project file (trusted folders only), then Octocode's global file, then Pi's project and global files (`.pi/`, `~/.pi/agent/`). They are never merged.

`SYSTEM.md` replaces only the opening wording, so the built-in policy sections (`work`, `research`, `safety`, `communication`...) still apply on top of it (`underCustomPrompt` in `sections/index.md`).

## Memory notes

Notes the agent saved or you wrote, kept apart from instructions. Full reference: [memory](memory.md).

| Scope       | Lives in                                                           | Seen by                                                       |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `session`   | The session itself (`S<n>`)                                        | This session only; re-sent after a compaction                 |
| `workspace` | Notes database; title mirrored in `.octocode/agent/MEMORY.md`      | This workspace (each git worktree has its own notes; the `MEMORY.md` file is the main checkout's, shared) |
| `project`   | Notes database                                                     | Every worktree of the repository                              |
| `global`    | Notes database; title mirrored in `MEMORY.md` of the Octocode home | Every repository                                              |

Both `MEMORY.md` files (global, then workspace) enter the `memory` section at session start: 30 lines (global) and 40 (workspace), 200 characters per line, 4 KB each. A leading `!` pins a line. Subagents read the workspace file only (`memory.subagents`); a lean subagent reads none. Edit with `/memory`, or ask the agent to remember something; the agent's `file` tool never edits these files, and a global or pinned save asks you first. Turn it off with `memory.file`, `memory.recall` and `memory.autoUpdate` (`/settings set memory.recall off`).

## Skills

Skills are folders with a `SKILL.md`. The model sees them as a list, not as prompt text: the `skill` tool's description holds `path: description` for every enabled skill (groups core, Octocode, workspace and global), and the model loads the matches before it starts. You can force one with `/skill:name` or `/name`. A skill adds instructions for the task; it never grants tools or permissions. Details: [skills](skills.md).

## Prompt templates

A Markdown file in `~/.octocode/octocodecode/prompts/` or the trusted project's `.octocode/prompts/` becomes `/name`, with `$1`, `$@` and `${1:-default}` arguments. The expanded text is your message, so it ranks as your request. Details: [prompt templates](prompt-templates.md).

## Harnesses: reading other tools' files

`/harness` lists and switches the sources Octocode reads besides its own. Switch one with `/settings enable|disable harness:<id> [--local]` ([configuration](configuration.md#harnesses)).

| Harness    | Skills, MCP, hooks and more from              | Default   |
| ---------- | --------------------------------------------- | --------- |
| Octocode   | `.octocode/` and the Octocode home            | always on |
| `agents`   | `.agents/skills`, `.agents/mcp.json`          | on        |
| `mcp-json` | root `.mcp.json`                              | on        |
| `pi`       | Pi skills, prompts, themes, MCP               | on        |
| `claude`   | Claude Code skills, MCP, hooks, plugins       | off       |
| `codex`    | Codex skills, MCP, hooks, plugins             | off       |
| `cursor`   | Cursor skills, MCP                            | off       |

When the same name exists in several harnesses, the earlier one wins: Octocode, `.agents`, `mcp-json`, Pi, Claude Code, Codex, Cursor (`VENDORS`, `core/discovery/vendors/registry.ts`). For single-valued files (global `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`) the product decides first, then scope: Octocode project, Octocode global, Pi project, Pi global (`core/discovery/precedence.ts`). A switched-off harness contributes nothing, except that `CLAUDE.md` project instructions load regardless. The main session's prompt lists the harnesses that supply something (`harnesses` section), so the agent can tell you `/harness` changes them.

## Quick recipes

| Goal                                         | Do                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Standing project rule                        | One line in the repository's `AGENTS.md`                              |
| A rule for one package                       | `AGENTS.md` in that folder                                            |
| Temporary local override you do not commit   | `AGENTS.override.md` (ignore it in git)                               |
| Personal rule for every project              | `AGENTS.md` in `~/.octocode/octocodecode/`, or a global memory line   |
| Reusable prompt                              | A template in `prompts/`                                              |
| Reusable procedure with files                | A skill                                                               |
| Check what loaded                            | `/harness config`, `/status`, `/harness list skills`                  |
