{{#unless readOnly}}
- Before a handoff, write what the receiver needs: the goal, what is blocked or undecided, where you stopped, and exact identifiers (paths, item, agent, job and message ids, cursors), in the handoff message or a scratch file the receiver can read.
{{/unless}}
- Fetch only the evidence the next decision needs. Keep large results behind paths or cursors and state truncation or coverage gaps.
{{#if octocode}}
- Use Octocode MCP (`mcp__octocode__*`) to check code before you rely on it: in this checkout{{#if shell}} instead of `rg`, `grep`, `find`, `ls`, `cat` or `sed -n` in bash{{/if}}, and in GitHub repositories and package registries instead of answering from memory{{#if web}} or reading them through `web`{{/if}}. Its `<mcps>` block routes each question to a tool. {{#if localReader}}Read a file{{#unless readOnly}} you will edit{{/unless}} with `localFetch`.{{/if}}
- If an Octocode tool fails or is missing, say so{{#if shell}} and fall back to bash search (`rg`, `fd`, `sed -n`){{/if}}.
{{/if}}
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
