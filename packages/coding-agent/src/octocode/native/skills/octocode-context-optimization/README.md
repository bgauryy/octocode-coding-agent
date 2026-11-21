# Octocode Context Optimization

Bundled with Octocode. It rewrites what agents read of skills before it reaches their context: each skill's description in the skills listing, reworded concisely without dropping any point. Rewrites are checked and stored under `<agent directory>/context-optimization/`.

- Start at [SKILL.md](SKILL.md).
- Output: a report and the overrides file under `<workspace>/.octocode/agent/octocode-context-optimization/` ([output.md](output.md)).
- Setup: the skill uses `octocode context`; no scripts.
