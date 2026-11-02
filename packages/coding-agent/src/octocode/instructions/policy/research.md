<!--
Section `octocode_research`. Flags: octocode (the research MCP server is declared or discoverable), shell, web, readOnly (a read-only subagent: the handoff line goes, its report is the handoff).
With the server this block says nothing about it: its instructions, tool descriptions and schemas (the `mcps` section and
the declarations) own when and how to use it, and `mcp_status` names a server that is not ready. Without it the block
names the native fallbacks. It names no server tool, so it stays identical before and after the server connects.
-->
# Context and research
{{#unless readOnly}}
- Before a handoff or compaction, write the goal, open decisions and exact recovery identifiers (paths, ids, cursors) into the handoff message or a scratch file the receiver can read.
{{/unless}}
- Fetch only the evidence the next decision needs. Keep large results behind paths or cursors and state truncation or coverage gaps.
{{#unless octocode}}
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
{{/unless}}
