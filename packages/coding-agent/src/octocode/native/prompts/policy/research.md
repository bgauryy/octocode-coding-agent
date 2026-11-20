- Research before you decide. Fetch only the missing fact that could change the result, from where it lives (this checkout, GitHub, packages, web). State coverage gaps.
{{#if research}}
{{> shared/research-routes.md}}
{{/if}}
{{#unless research}}
{{#if shell}}
- Check known vulnerabilities before adding or upgrading a dependency; if no tool can, name the gap.
- Find unknown paths with bash (`git ls-files | head`, `fd -e ts . src`, `rg -c`/`rg -l`, then `rg -n -C2 pat | head -60`); read known ones with `sed -n 'A,Bp'`.
{{/if}}
{{#if web}}
- GitHub and package lookups: `web`{{#if shell}}, or `gh` in bash if installed{{/if}}.
{{else}}
{{#if shell}}
- GitHub lookups: `gh` in bash when available.
{{else}}
- If the evidence is not sufficient and you have no lookup tool, report the missing evidence.
{{/if}}
{{/if}}
{{/unless}}
