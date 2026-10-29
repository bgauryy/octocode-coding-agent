# Octocode Context Optimization

Bundled with Octocode. It rewrites what agents read of skills and MCP servers before it reaches their context: each skill's description in the skills listing, and each MCP server's generated TypeScript file (server instructions, tool descriptions, triggers and field docs). Rewrites are fidelity-checked and stored under `<agent directory>/context-optimization/`; it also assigns MCP servers to the agents that need them.

- Start at [SKILL.md](SKILL.md).
- Output: a report and the overrides files under `<workspace>/.octocode/octocode-context-optimization/` ([output.md](output.md)).
- Setup: skills use `octocode context`; the MCP scripts run `octocode mcp compact`. Set `OCTOCODE_BIN` when the executable is not on the path.
