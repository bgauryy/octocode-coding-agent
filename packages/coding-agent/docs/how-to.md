# How to

Short recipes for common tasks. Each links to the page that owns the details. Commands starting with `/` run inside a session; the others run in a shell.

## Resume a session, or find the one that worked on a backlog item

- `octocode --continue` resumes the most recent session of the current folder. `/resume` (or `octocode --resume`) opens the picker; sessions are grouped by day, so yesterday's has its own heading. Tab switches between this folder and all folders.
- `/resume B346` lists only the sessions that held or hold backlog item B346; `/resume all B346` searches every repository.
- In a worktree, `--continue` and `--resume` see only that folder's sessions: use Tab in the picker or `octocode --session <id>`.

Details: [session commands](native-features.md#session-workflow-commands), [worktrees](native-features.md#worktrees).

## Rename a session, and turn off automatic titles

- `/rename <name>` names the current session, `octocode --name "<name>"` names a new one, and Ctrl+R in the `/resume` picker renames any session. A name you give is never overwritten.
- An unnamed interactive or RPC session gets a title after its first turn from a cheaper model; one still unnamed when it is compacted is titled from the summary's goal. Set `"sessions": { "autoTitle": false }` in `settings.json` to stop that; the first prompt then stays the title.

Details: [session titles](../../../CONFIGURATIONS.md#where-each-configuration-belongs) (the **Session titles** paragraph under the table), [settings reference](settings.md).

## Add an MCP server for this project only

1. `octocode mcp add --local docs -- npx -y some-mcp-server` (or `--url <url>` for a remote server) writes `.octocode/mcp.json`. `-l` is the short form of `--local`.
2. In a running session, `/trust config` approves the new file (it needs `/trust project` first), then `/reload`.
3. Check it: `/mcp list` in the session, or `octocode mcp list` in a shell, shows each server's connection state. `/mcp tools docs` lists its tools.

Details: [MCP quick setup](mcp.md#quick-setup), [managing servers](../../../CONFIGURATIONS.md#manage-mcp-servers), [project trust](permissions.md#project-trust).

## Make subagents use a cheaper model

- For one call, the `agent` tool's `model` field takes `small`, `medium`, `provider/id` or a bare id, optionally with a `:thinking` suffix (`small:high`). Ask the agent to "run this with a `small` model".
- For a role, set `model: small` in its profile front matter, for example in `.octocode/agents/<name>.md`. The bundled `researcher`, `browser` and `lean` roles already use `small`.
- `/modelsettings` shows which model `small` and `medium` resolve to and how each profile routes.

Details: [the subagent model](native-features.md#the-subagent-model), [profile front matter](native-features.md#profile-front-matter).

## Give the agent a durable rule for this repository

- `/memory add <title>` opens an editor for a project memory; or tell the agent "remember that …" and it saves one with the `memory` tool. Add `keywords` you would type when the rule matters. Pin it (`/memory`, pick it, **Pin**) to inject it before every prompt.
- It may not appear later when injection is off (`/memory auto`), the project is not trusted (`/trust project`), the prompt shares too few words with it, or it was already injected on this branch. `/memory last` shows what the latest injection contained.

Details and the full checklist: [memory](memory.md#memory).

## Run two sessions in parallel on different branches

- In a second terminal, run `octocode --worktree <name>`. It creates `.octocode/worktrees/<name>` on branch `worktree-<name>` at the current HEAD, or reuses it. From a session, `/worktree new <name>` does the same (inside tmux it opens a window).
- Add `.octocode/worktrees/` to `.gitignore`. List `.env`-style untracked files to copy in a `.worktreeinclude` file; dependencies are not installed.
- `/worktree list` shows each worktree's branch and unsaved work. Backlog, memory and the agent team stay shared.

Details: [worktrees](native-features.md#worktrees), [worktree files](../../../CONFIGURATIONS.md#where-each-configuration-belongs) (the **Worktree files** paragraph).

## See what happened in a compacted part of this session

- Ask the agent to look it up: it uses the `archive` tool, which searches this session's compacted messages and your repository's other sessions.
- `/archive` lists the compacted segments of this session; `/archive <n>` prints the file path of segment `n`, which you or the agent can read. It does not print the content.
- `/tree` navigates the session's branches.

Details: [compaction and recovery](native-features.md#compaction-and-recovery), [commands](commands.md).

## Limit what the agent may run, and trust a project

- The default mode is `full`. Start stricter with `OCTOCODE_PERMISSION=manual` (asks before every action class) or `workspace` (asks only for changes outside the workspace and destructive, private-network or upload actions), or switch in a session with `/permissions manual|workspace|full`.
- `/permissions grants` lists what you allowed for the session; `/permissions grants clear` removes it.
- `/trust project` lets Octocode load the project's resources; `/trust config` approves the exact hook, MCP, agent and skill files. This is not an operating-system sandbox.

Details: [modes](permissions.md#modes), [project trust](permissions.md#project-trust).

## Plan work as an epic with child items and steps

- Ask the agent to create an epic and its items: the `backlog` tool takes `type: "epic"` for the epic and `parentId` on each child. `backlog list` with `parentId` lists an epic's items; `backlog get` on the epic shows its derived state and a done count.
- Steps of one piece of work are tasks under the item you claim: the `steps` tool (`add`, `list`, `update`, `move`). An item cannot be done while it has open tasks.
- To see the hierarchy, run `/web backlogs` and open the **Tree** view (epic, item, task). `/backlog tui` shows the terminal board.

Details: [backlog view](web-workspace.md#backlog-view), [web controls for epics, items and tasks](web-workspace.md#web-controls-for-epics-items-and-tasks).

## Load a skill, and write your own

- `/skills` lists discovered skills; `/skills info <name>` shows where one came from; `/skills enable|disable <name>` switches it. Run a skill yourself by typing its command, `/<name>` (`/skill:<name>` when names collide). The agent loads one itself when its description fits the task.
- To write one, create `<name>/SKILL.md` with `name` and `description` front matter, then the instructions. Put it in `.octocode/skills/` (trusted project) or `~/.octocode/octocodecode/skills/` (all projects), then run `/reload`.
- Say in the description what the skill does and when to use it.

Details: [create a skill](skills.md#create-a-skill), [find and control skills](skills.md#find-and-control-skills), [skill locations](../../../CONFIGURATIONS.md#skills-and-prompts).
