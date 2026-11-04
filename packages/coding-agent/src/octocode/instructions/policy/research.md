- Fetch only the evidence the next decision needs. Keep large results behind paths or cursors and state truncation or coverage gaps.
{{#if research}}
- Use the research tools (`{{research.prefix}}*`) to check code before you rely on it: search with {{research.search}}{{#if localReader}} and read a file{{#unless readOnly}} you will edit{{/unless}} with {{research.reader}}{{/if}}{{#if shell}}, instead of `rg`, `grep`, `find`, `ls`, `cat` or `sed -n` in bash{{/if}}. Its `<mcps>` block routes each question to a tool, including sources outside this checkout{{#if web}} you would otherwise read through `web`{{/if}}.
- If one of these tools fails or is missing, say so{{#if shell}} and fall back to bash search (`rg`, `fd`, `sed -n`){{/if}}.
{{/if}}
{{#unless research}}
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
