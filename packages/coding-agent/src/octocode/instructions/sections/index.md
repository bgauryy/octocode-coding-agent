| Section | Tier | Under a custom prompt | Group | Written by |
| --- | --- | --- | --- | --- |
| preamble | base | replace | - | system/preamble.md, or the custom prompt |
| tools | base | keep | - | each tool's snippet, for the tools this agent declares |
| rules | base | keep | - | each tool's guidelines, for the tools this agent declares |
| docs | base | drop | - | system/docs.md |
| mcps | base | keep | - | sections/mcps.md, and the connected MCP servers' instructions, tools and schemas |
| addendum | session | keep | - | the user's APPEND_SYSTEM.md |
| cwd | session | keep | - | the working directory |
| work | session | keep | policy | sections/work.md |
| research | session | keep | policy | sections/research.md |
| delegation | session | keep | policy | sections/delegation.md |
| safety | session | keep | policy | sections/safety.md |
| communication | session | keep | policy | sections/communication.md |
| lean | session | keep | lean | sections/lean.md |
| project_context | session | keep | - | system/project-context.md and the project's AGENTS.md files |
| skills | session | keep | - | the skills this agent can load |
| hooks | session | keep | - | sections/hooks.md and the hooks configured for this session |
| role | session | keep | - | roles/<profile>.md and its skills |
| environment | volatile | keep | - | system/environment.md |
| planning | volatile | keep | - | workflows/planning.md |
| mcp_status | volatile | keep | - | sections/mcp_status.md and the MCP servers that are not ready |
