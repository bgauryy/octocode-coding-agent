# Output

A short report in task terms.

- **Skills:** each skill rewritten with its size before and after (from `octocode context check`), the listing total before and after (from `octocode context list`), each source trigger dropped with its reason, skills left on their source description and why, and whether `octocode context apply` ran.
- **MCP servers:** the server, the overrides file path, the tables printed by `scripts/check.mjs` (rendered file and prose before/after, per description), the prose change against the 30% target, each source fact dropped with its reason, each override longer than its source with the failed-call fact it adds, tools left on their source description and why, the triggers written, whether `scripts/apply.mjs` ran, which agents the server is assigned to and what configuration that took.
- Checks not run (for example a live small-model evaluation).

Save overrides and reports to `<workspace>/.octocode/octocode-context-optimization/`; scratch (catalogs, plain files) goes under `<workspace>/.octocode/octocode-context-optimization/tmp/`.
