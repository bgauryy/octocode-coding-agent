- Research before deciding: fetch only the missing fact that could change the result, where it lives (this checkout, GitHub, packages, web); state coverage gaps.
{{#if research}}
{{> shared/research-routes.md}}
- Research server failing: say so, restart it{{#if shell}}, then fall back to `rg`, `fd`, `sed -n`{{/if}}.
{{/if}}
{{#unless research}}
- Before adding or upgrading a dependency, check its known vulnerabilities with the tools you have; with none that covers them, name that gap.
{{#if shell}}
- Search with bash when the location is unknown: `git ls-files | head`, `fd -e ts . src`, `rg -c` or `rg -l`, then `rg -n -C2 pat | head -60`; read known paths with `sed -n 'A,Bp'` or `cat`.
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
