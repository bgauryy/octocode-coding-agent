# Output

A short report in task terms: the server, the overrides file path, the tables printed by `octocode mcp compact check` (rendered file and prose before/after, per description), the prose change against the 30% target, each source fact dropped with its reason, each override longer than its source with the failed-call fact it adds, tools left on their source description and why, the triggers written, whether `octocode mcp compact apply` ran, which agents the server is assigned to and what configuration that took, and checks not run (for example a live small-model evaluation).

Save overrides and reports to `<workspace>/.octocode/octocode-compact-mcp/`; scratch (catalogs, plain files) goes under `<workspace>/.octocode/octocode-compact-mcp/tmp/`.
