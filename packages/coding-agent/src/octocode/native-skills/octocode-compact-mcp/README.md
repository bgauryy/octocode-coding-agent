# Octocode Compact MCP

Bundled with Octocode. It turns an MCP server into the generated TypeScript file every agent that selects the server reads: it rewrites the server's instructions, tool descriptions, triggers and field docs as fidelity-checked overrides, and assigns the server to the agents that need it.

- Start at [SKILL.md](SKILL.md).
- Output: a report and the overrides file under `<workspace>/.octocode/octocode-compact-mcp/` ([output.md](output.md)).
- Setup: the scripts run `octocode mcp compact`; set `OCTOCODE_BIN` when the executable is not on the path.
