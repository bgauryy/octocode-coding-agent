# States and marks

## States

| State     | Means                                                                                   | Leaves by                                                                       |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `backlog` | Proposed: the triage inbox where new items land                                         | Accepting it into `todo`, or closing it                                         |
| `todo`    | Accepted, not started                                                                   | `claim` (ongoing), or closing it                                                |
| `ongoing` | Claimed by one session or subagent, the assignee                                        | `done`, `close`, or returning it to `todo`/`backlog`, which releases the claim  |
| `done`    | Finished, with a completion: a summary and a verification                               | Reopening it with a note; the store then names the done items that waited on it |
| closed    | Ended without doing it: `obsolete`, `duplicate` (with `of`) or `wont_do`, with a reason | Reopening it with a note                                                        |

An epic's state follows its items. Adding children to a done parent is refused: reopen the parent first.

## Write rules

- `done` and `close` are refused while the item has open steps: finish or close the steps first (`backlog` `step`).
- While another live session holds an item, others may only add a note. A subagent may only touch items its parent holds, so children report verdicts and the coordinator writes them.
- A session that exits gracefully returns its ongoing items to todo, and resuming it restores them. A holder that ended without a graceful exit leaves a stale claim, which the store returns to todo after a day idle; anyone may claim it sooner.

## Marks on a row

| Mark                    | Means                                     | Action                                                                      |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `(stale: holder ended)` | Ongoing, but its holder's process is gone | Take it over, or return it to todo with a note                              |
| `blocked by B…`         | A prerequisite in `dependsOn` is not done | Keep it out of the next sprint. Check that the prerequisite is still wanted |
| `review B…`             | Done, but items under it are still open   | Close or finish the children, or reopen the parent                          |
| `(worked on by …)`      | A live child run works on it              | Leave it alone                                                              |
| `n open steps`          | Unfinished steps under it                 | Finish or close them before closing the item                                |
