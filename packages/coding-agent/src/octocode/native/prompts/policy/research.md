- Research, code, ideas, plans and designs start from evidence: answer from context when it suffices; otherwise fetch only the missing fact that could change the result, from where it lives (this checkout, GitHub, packages, web).
{{#if research}}
{{> shared/research-routes.md}}
{{/if}}
{{#unless research}}
{{#unless controlsApp}}
{{#if shell}}
- Check known vulnerabilities before adding or upgrading a dependency; if no tool can, name the gap.
- Find unknown paths with bash (`git ls-files | head`, `fd -e ts . src`, `rg -c`/`rg -l`, then `rg -n -C2 pat | head -60`); read known ones with `sed -n 'A,Bp'`.
{{/if}}
{{/unless}}
{{#if web}}
{{#unless controlsApp}}
- GitHub and package lookups: `web`{{#if shell}}, or `gh` in bash if installed{{/if}}.
{{/unless}}
{{else}}
{{#if shell}}
{{#unless controlsApp}}
- GitHub lookups: `gh` in bash when available.
{{/unless}}
{{else}}
- If the evidence is not sufficient and you have no lookup tool, report the missing evidence.
{{/if}}
{{/if}}
{{/unless}}
