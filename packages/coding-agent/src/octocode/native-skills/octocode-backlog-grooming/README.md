# Octocode Backlog Grooming

Bundled with Octocode. It teaches agents to review a repository's backlog like a sprint review. For each open item it checks the state and marks (stale claims, prerequisites, open children), the timing against the code's history, and the relevance against the current code and tests. It also checks overlap with other items, research findings, RFC status and who can own the item. It closes or completes items only on spot-checked evidence, adds notes, assigns work by claiming or delegating, and reports the board before and after.

- Start at [SKILL.md](SKILL.md).
- References: [states and marks](references/states.md), [verdicts and their evidence](references/verdicts.md), [delegating large boards](references/delegation.md).
- Output: [output.md](output.md). Large reports go under `<workspace>/.octocode/backlog-grooming/<date>/`.
- Setup: none. It uses the `backlog`, `backlogPlan`, `agent` and `askUser` tools, and `git` for timing.
