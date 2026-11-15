# Verdicts

Each verdict needs the evidence named here before you write it. When the evidence is partial, keep the item and add a note.

| Verdict      | Evidence that justifies it                                                                                                           | Write                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| done         | Every "Done when" clause holds: the code at path:line, a passing test run you or a checked child ran, the named platform or approval | `backlog` `done` with `completion` `{summary, verification, files}`; `verification` starts with "Passed:" or "Not applicable:" and names the check |
| obsolete     | The problem no longer exists: the code or feature is gone, or a failing test now passes on the current tree                          | `backlog` `close` `{kind: "obsolete", text}`                                                                                                       |
| duplicate    | Another open or done item covers the same goal, or its goal states that it fixes this one                                            | `close` `{kind: "duplicate", of: "B…", text}`; add to the original as a note anything this item had that it lacks                                  |
| won't do     | The user decided against it                                                                                                          | `close` `{kind: "wont_do", text}` quoting the decision; ask first                                                                                  |
| promote      | A backlog item has a checkable goal, a why, and still applies                                                                        | `backlogPlan` `edit` `{id, state: "todo"}`                                                                                                         |
| reprioritize | Its impact or urgency changed: a user request, a blocker for other items, a security or data-loss risk                               | `backlogPlan` `edit` `{id, priority}` and a note giving the reason                                                                                 |
| split        | Part is done or the goal mixes unrelated work                                                                                        | Add the remainder with `from` and `parentId`, and narrow or finish the original                                                                    |
| release      | Stale claim                                                                                                                          | `claim` it, or `backlogPlan` `edit` `{id, state: "todo", note}`                                                                                    |
| reopen       | A done item regressed or its completion's evidence is wrong                                                                          | `backlogPlan` `edit` `{id, state: "todo", note}`; review the done items it names                                                                   |
| keep         | Still open and still relevant                                                                                                        | Nothing, or a note with what you checked and what is left; fix stale paths, links and dependencies with `edit`                                     |

## Traps

- **A passing focused test is not a full-suite result.** Close an item that asks for full suites, or for several runs, only with those runs.
- **A different environment does not satisfy the goal.** A goal that names a platform or runtime version is met only on that platform or version.
- **Code that exists is not code that is tested.** When the goal asks for a regression test, read the test and check that it covers the named case.
- **Old evidence lines move.** Read the current file, not the line the item cites.
- **A failure that does not reproduce once is not a fix.** For a flaky or load-dependent failure, rerun it under the original conditions, or keep the item with a note.
- **Another session's item.** Even a verdict you are sure of becomes a note or a message to its holder.
