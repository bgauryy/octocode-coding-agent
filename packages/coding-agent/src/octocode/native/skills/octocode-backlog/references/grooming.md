# Groom the backlog

Only the orchestrator (main session) runs this pass and applies its writes. Children may check delegated batches read-only and report verdicts; they never groom or write the board themselves.

Bring the requested scope up to date with the code, live sessions and the user's decisions: every `backlog` item for proposed-item triage, every open item for a full groom. Use only `backlog` and `backlogPlan` for board reads and writes. Ids are per repository; never query the shared database directly.

## 1. Snapshot

1. Run `octocode backlog groom` with `bash` first. Judge its flagged stale claims, finished epics, gone paths, likely duplicates, and blocked or idle items before anything else; do not redo its mechanical checks.
2. Take before-counts from `backlogPlan` `stat` or `list`; list the requested scope with `sort` `board`, `limit` 200 to judge rows the report did not flag.
3. Run `agent` `coordinate` `list`. An item a live session or child holds is theirs: only `note` it or `message` the holder with a finding.
4. Read items in batches with `backlog` `get`: goal, why, paths, evidence, plan, notes, steps, prerequisites, and created, updated and claimed ages.
5. For more than about 40 items, delegate read-only batches per [delegation](delegation.md); you apply every change.

## 2. Check each item

Take the goal literally: every "Done when" clause, named test, platform and approval must hold. Read [states](states.md) for columns, marks and allowed changes.

| Check     | How                                                                     | Signal                                                                                    |
| --------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| State     | Column, marks, open steps                                               | Wrong column, stale claim, blocked item in todo, done parent with open children           |
| Timing    | Ages from `get`; `git log --since="<updated ISO>" --oneline -- <paths>` | Code changed after the last update; idle ongoing work; untriaged proposals                |
| Relevance | Read current paths/symbols; rerun the cited focused test when needed    | Fixed or gone problem, or an unmet goal                                                   |
| Overlap   | Search `touchingPaths`, `query`, `underEpic`, origin and verification   | Duplicate, redundant items to merge, a child folded into its parent, or covered follow-up |
| Value     | Impact, urgency, risk, unblocked work and stated user priorities        | Priority and importance ranking; not ease or age alone                                    |
| Research  | Read saved findings, links, notes and completion                        | Answered question to finish, or a decision for the user                                   |
| RFC       | Read the linked RFC's status, decision and slices                       | Accept and slice, ask when pending, close when rejected or superseded                     |
| Owner     | Live holder and capable owner: you, child, session or user              | Assign, or note the missing decision, prerequisite or platform                            |

Give each item one verdict with path:line, command output or report evidence; see [verdicts](verdicts.md). Similar titles or shared files alone do not prove redundancy.

## 3. Apply

1. Spot-check every non-keep verdict yourself. A child's verdict is a claim; partial evidence means keep and note the gap.
2. Apply supported changes in the same pass, including user answers; do not leave evidence-backed merges, closures, promotions or notes as recommendations.
3. Write through the tools: one item per `backlog` call, field/state batches through `backlogPlan` `edit`. Every close, done or reopen states its evidence. Never weaken a goal; split an unmet remainder with `from`.
4. Merge redundant items per [verdicts](verdicts.md#merging-redundant-items): update the survivor first, preserve every distinct requirement and useful link, then close absorbed items as duplicates of it.
5. For research, record the conclusion and saved findings. For an accepted RFC, link the RFC and add slices under its epic.
6. `note` what changed, what holds, and what remains when a check informs later work but changes no state, and whenever an item stays blocked or held. Notes are allowed on items held by others.
7. Batch only user-owned decisions (won't-do, priority conflicts, scope-changing merges, RFC acceptance, paid runs) into one `askUser` call of at most 4; leave those items unchanged until answered.

## 4. Assign

Claim work you will do now; delegate with `agent` `task` `item`; message live holders rather than editing their claims; take over or release stale claims with a note. Promote ready, unowned items to todo. If one waits, note the decision, prerequisite or platform and use `notify` `on` `item.state` when another item unblocks it.

## 5. Report

Use [output](../output.md): before/after counts, applied changes and evidence, the most important items, user decisions, blocked/held work, ready next work and unchecked scope.

Done when every item in scope has an evidence-backed verdict, every non-keep verdict was spot-checked and written, the after-counts come from a fresh `stat` or `list`, and the report names held or unchecked items.
