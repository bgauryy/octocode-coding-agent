# Glossary

One definition per term, and a link to the page that owns it. Instructions and docs use these words in these senses.

## Agents and teams

- **Coordinator**: the agent that starts and directs subagents: it writes their tasks, answers their questions, decides, and owns the user conversation and integration. A subagent follows its coordinator's task and decisions and sends blockers, decisions and conflicts to it. The `agent` tool addresses it as `to: "parent"` (the machine value stays `parent`). A separate, narrower use: from a linked worktree, `to: "coordinator"` reaches this repository's session in the main checkout, the one that lands merges. See [Finishing a worktree](native-features.md#finishing-a-worktree) and [Team mail](native-features.md#team-mail).
- **Subagent (child)**: an agent a coordinator starts with the `agent` tool for one bounded goal, in its own process and saved session. It reports back with an outcome. See [Communication and results](native-features.md#communication-and-results); its model and thinking follow [the subagent model](native-features.md#the-subagent-model).
- **Team and teammate**: every subagent joins the team of its coordinator, in any git worktree of the repository. Teammates see each other in `coordinate list`, message each other by id or unique role name, and reserve files so edits do not collide. A subagent reaches only its own tree; its coordinator relays beyond it. See [Team mail](native-features.md#team-mail) and [Worktrees](native-features.md#worktrees).
- **Worktree agent (isolated child)**: a subagent started with `isolate: true`. It works in its own git worktree; its changes are exported to `refs/octocode/<id>` and the coordinator lands them with `coordinate` `merge`. It is on the same team as any other child. See [Worktrees](native-features.md#worktrees).
- **Profile (role)**: a named subagent definition (instructions, tools, permissions, model preference) chosen with the task's `profile`; omitted, the child is general-purpose. See [Profile front matter](native-features.md#profile-front-matter) and [User instructions and subagent roles](instructions.md#user-instructions-and-subagent-roles).
- **Report outcome**: the first word of a subagent's final report: `done`, `partial`, `blocked` (waits for an answer) or `failed`. Any other opening leaves the outcome unknown. See [Communication and results](native-features.md#communication-and-results).

## Coordination and work

- **Reservation (lock)**: a claim on files or a tree, made with `coordinate` `lock` or through a task's `paths`, that blocks other agents' edits and `bash` writes to those paths until released or the run ends. Scripts and other editors ignore it. See [Team mail](native-features.md#team-mail) and [Tool selection](native-features.md#tool-selection-and-migration).
- **Lease (peer)**: an advisory path lease that an agent of another vendor (Claude, Codex) keeps in the shared agents-communication database. Octocode reads it before a write and refuses when a live lease covers the file; a missing or unknown-version database means no lease. See [`peer-leases.ts`](../src/octocode/team/peer-leases.ts).
- **Backlog item**: a durable work record (states `backlog`, `todo`, `ongoing`, `done`, `closed`) with a goal, a plan and evidence. A subagent updates only the item its task names. See [Backlog view](web-workspace.md#backlog-view) and [Backlogs](../../../docs/ENTITIES.md#backlogs-small-at-capture-useful-at-completion).
- **Step**: a tracked unit inside one piece of work (states `todo`, `ongoing`, `done`, `dropped`), kept under the held backlog item or on the session. See [Tool selection](native-features.md#tool-selection-and-migration).
- **Scratch**: an agent's own folder, `.octocode/code/temp/agents/<id>/`, for its saved session and files it hands back; cleared after a retention period without writes unless the user keeps it. See [Communication and results](native-features.md#communication-and-results).
- **Timer and `waitUntil`**: the `timer` tool wakes the session that set it, once after a delay, every N seconds, or once when a condition holds (`unlocked`, `file`, `item`, `agent`, `port`, `command` or `check`). See [Tool selection](native-features.md#tool-selection-and-migration).

## Session and context

- **Session**: one saved conversation with its own id and transcript. `/new`, `/resume` and `/fork` start or continue one. See [Session workflow commands](native-features.md#session-workflow-commands).
- **Compaction**: summarizing older turns when the context nears its limit, so the session continues from the summary and the archive. See [When compaction runs](../../../docs/CONTEXT.md#when-compaction-runs) and [Compaction and recovery](native-features.md#compaction-and-recovery).

## Extensions and permissions

- **Harness**: another agent product's configuration (Pi, Claude Code, Codex, Cursor) that Octocode can read for skills, hooks, MCP servers and instructions; switched with `/harness`. See [Commands](commands.md) and [Configuration and Pi compatibility](configuration.md).
- **Skill**: a folder with `SKILL.md` (name, description, instructions) that the model loads when its description matches the task. See [Skills](skills.md).
- **MCP server and role**: an MCP server is an external tool provider the agent connects to and enables or disables. A server preset may group its tools into named roles (such as reader, search, read-only), so instructions can route by capability instead of by tool name. See [MCP servers](mcp.md) and the [preset roles](../../mcp/src/recommended/octocode.json).
- **Permission mode**: how much the agent may do without asking: `manual`, `workspace`, `full` (the default) or `bypass`. See [Modes](permissions.md#modes).
