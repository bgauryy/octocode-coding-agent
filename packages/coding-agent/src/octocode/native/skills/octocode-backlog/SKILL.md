---
name: octocode-backlog
description: "Use to file, update, split, close or groom backlog items (what an item needs, research plans, follow-ups) or run a sprint review: check each open item for state, age, relevance, evidence; close done, obsolete or duplicate ones, release stale claims, reprioritize, assign, comment, report the board before and after."
metadata:
  audience: coordinator
---

# Backlog items

Read and write the board only with `backlog` and `backlogPlan`; ids such as `B12` are per repository.

## File or update an item

- Reuse a matching item (`backlogPlan` `list` with `query` or `touchingPaths`) before adding one.
- Every item: a checkable goal (Definition of Done), why, paths and evidence (path:line, command).
- Research: `plan` holds the trigger, root cause or hypothesis, evidence and the check that tells causes apart. Link saved research or RFCs as `evidence`.
- Follow-ups: `from` the origin item, the trigger and the fix.
- Finish with `done` (the result and the check that proved it) or `close` (obsolete, duplicate of, won't do). An unmet goal stays: split the rest into a new item with `from`.
- Waiting on another item: `wait` `on` `item.state`, not polling.

## Groom the board

For a sprint review of every open item (state, age, relevance, overlap, owner, verdicts, a before/after report), follow [grooming](references/grooming.md) and report in the [sprint report format](output.md).
