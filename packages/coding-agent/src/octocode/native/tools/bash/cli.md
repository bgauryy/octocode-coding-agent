Host: {{os}} {{arch}}. PATH: {{present}}{{#if missing}}; missing: {{missing}}{{/if}}. gh: {{gh}}. Other tools: `command -v`.
{{#if darwin}}BSD: `sed -i ''`, `stat -f`, `date -v`, `shasum`, `rg -P` (not `grep -P`), tool timeout (not GNU `timeout`); `top`, `lsof`.{{/if}}{{#if linux}}GNU: `sed -i`, `stat -c`, `date -d`, `sha256sum`, `grep -P`; `ps`, `ss`.{{/if}}{{#if windows}}Git Bash GNU tools; Windows state: `type: powershell` with `Get-Process`, `Get-NetTCPConnection`.{{/if}} Check flags with `--help`: GNU/BSD differ.
For output, logs, JSON and git (not source), narrow before reading:
- Files: `fd -e EXT --changed-within 1h`, `ls -lt | head`; archives: `tar -tzf`, `unzip -l`.
- Search, trim: `rg -l`, `-c`, `-m N`, `--max-columns N`; `head`, `tail`, `sed -n 'a,bp'`, `cut -c`; `2>&1` keeps errors.
- JSON: `jq 'keys'` or `'length'`, then select the path; YAML or TOML without `yq`: `python3`.
- Git: `status -s`, `diff --stat`, then `diff -- path`; `log -S 'text'`; `diff --check` before handoff.
- Compare, count: `diff -u`, `comm -3`, `wc`, `du -sh`, `sort | uniq -c | sort -rn`.
- Runners: count failures (vitest `×`, `N failed`), not lines. Name output caps before claiming absence.
