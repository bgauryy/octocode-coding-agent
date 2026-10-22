# Agent instructions

Octocode Code owns its agent policy and bundled subagent instructions in [`src/octocode/instructions/`](../src/octocode/instructions/). The Pi extension was the migration source; the native runtime does not load its prompt implementation.

| Instruction | Owner | How it reaches the model |
|---|---|---|
| Common work, research, delegation and safety policy | `instructions/policy.ts` | The named `octocode` system section, adapted to the current tools and main/child role |
| Bundled specialist profiles | `instructions/roles/*.md` | Profile metadata controls selection; the selected body becomes the child's named `role` section |
| Child identity, goal, scratch folder and teammates | `instructions/task.ts` | The task message, after the stable system instructions |
| Report outcome and preview contract | `instructions/report.ts` | Used by both the policy renderer and report handling |
| Generic system assembly | `core/system-prompt.ts` | Combines the base prompt, tools, user additions, project context, skills and named sections |
| Tool-specific mechanics | Each tool's declaration and guidelines | Tool schemas and the active-tool rules |
| MCP server instructions | The connected server | Its instruction text is included through the MCP integration |
| Compaction task and summary format | `octocode/compaction/summary.ts` and `shared-summary.ts` | A summarization request with the existing transcript and recovery requirements |

The common policy does not copy tool schemas, skill bodies or project instructions. Their existing loaders remain authoritative. Bundled role files are package assets; use user or trusted project profiles for local customization rather than editing installed defaults.

Compaction instructions remain with the summarizer because they define its saved output and recovery format. They are task-specific instructions, separate from persistent main-agent and subagent policy.

## User instructions and subagent roles

`SYSTEM.md` replaces the generic base prefix. `APPEND_SYSTEM.md` supplies additional user instructions. Discovery prefers the trusted current project's `.octocode/` file, then the agent directory's file. Explicit CLI prompt options retain their existing replacement behavior. Project context files such as `AGENTS.md` remain a separate section, and skills use the normal discovery and on-demand loading flow.

A subagent role does not occupy `--append-system-prompt`. The parent saves the selected role's exact text in a private file and hands its path only to that child. The child loads it into `role`, preserving independently discovered `APPEND_SYSTEM.md` content. Child identity and task details stay outside the system policy. A main session does not load a child role from an inherited environment setting.

Profile lookup still applies bundled defaults, user configuration, the runtime home, then trusted project profiles. A later profile with the same name replaces the earlier one. User profile locations and tool/permission controls are unchanged.

## Updates and caching

Unchanged instruction inputs produce unchanged section text. Changes to tools or instructions produce the core's normal system-section updates; cache stability does not justify retaining instructions for unavailable tools. Child-specific names and scratch paths do not enter the reusable policy.

Different roles, tool sets or project context can still change the provider's cached prefix. See [prompt caching](prompt-caching.md) for retention settings and limits, [skills](skills.md) for discovery, and [MCP](mcp.md) for server configuration.
