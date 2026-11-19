- Research before you decide. Fetch only the missing fact that could change the result, from where it lives (this checkout, GitHub, packages, web). State coverage gaps.
{{#if research}}
{{> shared/research-routes.md}}
{{/if}}
{{#unless research}}
- Before you add or upgrade a dependency, check its known vulnerabilities with your tools. If no tool covers them, name that gap.
{{#if shell}}
- If the location is unknown, search with bash: `git ls-files | head`, `fd -e ts . src`, `rg -c` or `rg -l`, then `rg -n -C2 pat | head -60`. Read known paths with `sed -n 'A,Bp'` or `cat`.
{{/if}}
{{#if web}}
- For GitHub and package registry lookups, use `web`{{#if shell}} (or the `gh` CLI in bash when available){{/if}}.
{{else}}
{{#if shell}}
- For GitHub lookups, use the `gh` CLI in bash when available.
{{else}}
- If the evidence is not sufficient and you have no lookup tool, report the missing evidence.
{{/if}}
{{/if}}
{{/unless}}
