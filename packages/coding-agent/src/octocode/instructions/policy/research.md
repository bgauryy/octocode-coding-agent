<!--
Section `octocode_research`. Flags: octocode (Octocode MCP tools declared or discoverable), shell, web, readOnly,
shellWrite (shell and not readOnly), browse (a browser is reachable and `web` is active).
The first Octocode line is the text `policyRoutesSearchToOctocode` (policy.ts) looks for: `core/system-prompt.ts` leaves
its own bash search rule out while a session's sections carry it, so only one of the two shows.
The prompt says when to reach for Octocode MCP; which tool answers which question is the server's own business (its
instructions and tool descriptions), so this block names none and stays identical before and after the server connects.
-->
# Context and research
- Before a handoff or compaction, write the goal, open decisions and exact recovery identifiers (paths, ids, cursors) into the handoff message or a scratch file the receiver can read.
- Fetch only the evidence the next decision needs. Keep large results behind paths or cursors and state truncation or coverage gaps.
{{#if octocode}}
- Use Octocode MCP (`mcp__octocode__*`) to check code before you rely on it, here{{#if shell}} (instead of ls, rg, grep or find in bash){{/if}} and in GitHub or package registries outside this repository (instead of answering from memory). Its `<mcps>` block routes each question to a tool.
- Use `localFetch` for {{#if readOnly}}files you know{{else}}a file you will edit{{/if}}.{{#if shellWrite}} Use bash for builds, tests, git and running commands.{{/if}} If an Octocode tool is unavailable, say so{{#if shell}} and use permitted bash search (`rg`, `fd`, `sed -n`){{/if}}. A permission refusal is not a reason to retry through another tool.
{{else}}
{{#if shell}}
- Search with bash (`rg`, `fd`) when the location is unknown; read known paths with `sed -n` or `cat`.
{{/if}}
{{#if web}}
- Use `web`{{#if shell}} (or the `gh` CLI in bash when available){{/if}} for GitHub and package registry lookups.
{{else}}
{{#if shell}}
- Use the `gh` CLI in bash when available for GitHub lookups.
{{else}}
- If the supplied evidence is insufficient and no lookup tool is available, report the missing evidence.
{{/if}}
{{/if}}
{{/if}}
<!-- Browser routing depends on what this session holds, so it is policy, not a static `web` guideline; without a browser the delegation section names the specialist, and a child without one reports the need (its role says so). -->
{{#if browse}}
- When static text from `web` cannot answer the question, use the browser tools (`mcp__browser__*`).
{{/if}}
