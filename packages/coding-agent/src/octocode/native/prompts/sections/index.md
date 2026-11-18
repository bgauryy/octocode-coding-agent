| Section | Tier | Under a custom prompt | Group | Chunks | Written by |
| --- | --- | --- | --- | --- | --- |
| preamble | base | replace | - | - | system/preamble.md, or the custom prompt |
| tools | base | keep | - | - | each tool's snippet, for the tools this agent declares |
| rules | base | keep | - | - | each tool's guidelines, for the tools this agent declares |
| docs | base | drop | - | - | system/docs.md |
| mcps | base | keep | - | - | sections/mcps.md, and the connected MCP servers' instructions, tools and schemas |
| addendum | session | keep | - | - | the user's APPEND_SYSTEM.md |
| work | session | keep | policy | `policy/readonly.md` readOnly, `policy/work.md` !readOnly | the policy renderer |
| research | session | keep | policy | `policy/research.md` | the policy renderer |
| delegation | session | keep | policy | `policy/delegation.md` main agentTool | the policy renderer; the main session only |
| children | session | keep | policy | `policy/children.md` main agentTool childStarted | the policy renderer; the main session, from its first `agent` call that starts a child or messages an agent |
| subagent | session | keep | policy | `policy/subagent.md` !main !readOnly | the policy renderer; a subagent that may write |
| safety | session | keep | policy | `policy/safety.md` !readOnly | the policy renderer |
| communication | session | keep | policy | `policy/communication.md` | the policy renderer |
| lean | session | keep | lean | `lean/lean.md` | the lean renderer |
| project_context | session | keep | - | - | system/project-context.md and the project's AGENTS.md files |
| skills | session | keep | - | - | the skills this agent can load |
| hooks | session | keep | - | - | sections/hooks.md and the hooks configured for this session |
| role | session | keep | - | - | agents/<profile>.md and its skills |
| harnesses | session | keep | - | - | system/harnesses.md and system/harness.md, for the harnesses Octocode reads, on or off (`core/discovery/vendors/prompt.ts`); the main session only |
| cwd | volatile | keep | - | - | the working directory |
| environment | volatile | keep | - | - | system/environment.md |
| planning | volatile | keep | - | - | workflows/planning.md |
| mcp_status | volatile | keep | - | - | sections/mcp_status.md and the MCP servers that are not ready |
| tools_off | volatile | keep | - | - | notices/tool-off.md, while a tool turned off this span stays declared on a transport that cannot remove it |
