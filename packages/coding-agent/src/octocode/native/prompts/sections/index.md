| Section | Tier | Under a custom prompt | Group | Chunks | Written by |
| --- | --- | --- | --- | --- | --- |
| preamble | base | replace | - | - | system/preamble.md, or the custom prompt |
| tools | base | keep | - | - | each tool's snippet, for the tools this agent declares |
| rules | base | keep | - | - | each tool's guidelines, for the tools this agent declares |
| docs | base | drop | - | - | system/docs.md |
| mcps | base | keep | - | - | sections/mcps.md, and the connected MCP servers' instructions, tools and schemas |
| addendum | session | keep | - | - | the user's APPEND_SYSTEM.md |
| work | session | keep | policy | `policy/understand.md`, `policy/readonly.md` readOnly, `policy/change.md` !readOnly, `policy/finish.md`, `policy/linked.md` linked | the policy renderer |
| research | session | keep | policy | `policy/research.md` | the policy renderer |
| delegation | session | keep | policy | `policy/delegation.md` main agentTool | the policy renderer; the main session only |
| subagent | session | keep | policy | `policy/subagent.md` !main | the policy renderer; every subagent |
| safety | session | keep | policy | `policy/safety.md` | the policy renderer |
| communication | session | keep | policy | `policy/communication.md` | the policy renderer |
| lean | session | keep | lean | `lean/lean.md` | the lean renderer |
| project_context | session | keep | - | - | system/project-context.md and the project's AGENTS.md files |
| memory | session | keep | - | - | notices/memory-file-header.md and the global and workspace MEMORY.md files, read at session start and again after a compaction that finds them changed |
| hooks | session | keep | - | - | sections/hooks.md and the hooks configured for this session |
| role | session | keep | - | - | agents/<profile>.md and its skills |
| harnesses | session | keep | - | - | system/harnesses.md and system/harness.md, for the harnesses that are on and supply something (`core/discovery/vendors/prompt.ts`); none when no harness does; the main session only |
| children | session | keep | policy | `policy/children.md` main agentTool, `policy/child-reports.md` main agentTool !subagentsSkill | the policy renderer; every main session with the agent tool, from its first request so delegation never rewrites the prompt; the report rules only when the `octocode-subagents` skill, which carries them and arrives with the first child task, cannot be loaded |
| cwd | volatile | keep | - | - | the working directory |
| environment | volatile | keep | - | - | system/environment.md |
| planning | volatile | keep | - | - | workflows/planning.md |
| mcp_status | volatile | keep | - | - | sections/mcp_status.md and the MCP servers that are not ready |
| tools_off | volatile | keep | - | - | notices/tool-off.md, while a tool turned off this span stays declared on a transport that cannot remove it |
