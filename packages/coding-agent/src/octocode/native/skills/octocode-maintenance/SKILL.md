---
name: octocode-maintenance
description: "Use when the user asks for maintenance or a health sweep: dependencies, dead code, stale docs, lint drift, flaky tests, Octocode upkeep (retention, worktrees, caches, MCP), saved memories, backlog; then fixes or files findings. Not one failure or edit."
metadata:
  audience: coordinator
---

# Maintenance sweep

Sweep first, act second. Each area below ends in a finding, then either a fix within scope, a backlog item (octocode-backlog) or a question to the user. Report the sweep as a list: area, finding, evidence, action taken or filed. Do not fix while sweeping and do not widen into unrelated work. Run one heavy command at a time, in the background with output under `.octocode/tmp/`; check what already runs first.

## Repository

| Area                  | Check                                                                                                               | Finding becomes                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Dependencies          | `yarn outdated` or `yarn npm audit`; read the changelog of a major bump                                             | An item per upgrade with the breaking changes; a security advisory is a fix item |
| Dead code             | `yarn knip`, then confirm each candidate with `lspSearch` references and a search for registration, config and docs | Delete the confirmed code with its tests; list the rest as candidates            |
| Stale docs            | Compare docs' commands, flags and paths with the code (search each name); check links                               | Fix the page that owns the fact                                                  |
| Lint and format drift | `yarn run check` (rewrites nothing), `yarn oxfmt <files>` for formatting                                            | Fix in the touched files; report an old failure instead of hiding it             |
| Flaky tests           | Rerun a suspect test file a few times, alone; compare with the failure's log                                        | An item with the trigger, the rate and the suspected cause; never skip the test  |

## Octocode upkeep

| Area                   | Check                                                                                                                                                              | Finding becomes                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention              | `retention.days` and `retention.sessionDays` are set and the sizes of `.octocode/code/` folders, `.octocode/tmp`, transcripts and the database are sane (`du -sh`) | Automatic cleanup handles normal growth; an item when it does not. Manual removal is `/purge`, which previews and needs the user's typed confirmation |
| Worktrees              | `/worktree list` and `git worktree list`: merged branches, detached and abandoned trees, changed counts                                                            | Ask before `/worktree remove`; never remove one with uncommitted work                                                                                 |
| Caches, logs, sessions | Old scratch under `.octocode/code/temp/agents/`, bash logs, large session folders                                                                                  | Retention removes them; ask before deleting anything sooner                                                                                           |
| MCP health             | `/mcp list`; a server that fails or times out: restart it with `mcp`                                                                                               | Report persistent failures with the last error                                                                                                        |

## Memories

List the memories (`memory` `list`; `/memory review` shows notes never recalled or not updated lately). For each, check its named file, function, flag or decision against the code, and against newer memories. Wrong or stale: update it. Duplicate: merge into one. Obsolete or nothing left to say: delete. Follow octocode-memory for wording and scope, and ask the user before changing a global or pinned note.

## Backlog

Run `octocode backlog groom` first: code flags stale claims, finished epics, gone paths, duplicates, blocked and idle items at no model cost. Then groom per octocode-backlog's grooming reference, judging the flagged rows first. An item a live session holds gets a note, not a change.

## Act

Safe, reversible fixes inside your scope may be made now. Anything destructive or irreversible (deleting data, worktrees, sessions, memories others rely on, pushing, a dependency bump with breaking changes) waits for the user's yes. Name what you did not check.
