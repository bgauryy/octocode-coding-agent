# Output

A sprint report, result first.

1. **Board:** a table of open items per state (backlog, todo, ongoing), plus closed and done in this pass. Show the before and after counts and the change (Δ). Take both from `backlogPlan` `list`.
2. **Changes:** a table of verdict groups (done, obsolete, duplicate, promoted, reprioritized, released, reopened, split). List each group's items, with one line of evidence per item or per shared cause.
3. **Kept despite a done-looking verdict:** each item and the goal clause still unmet.
4. **Needs the user:** the questions asked, or still to ask, and their items.
5. **Blocked or held:** items held by live sessions, with their holders; stale claims you released; items blocked by prerequisites.
6. **Next sprint:** the todo items that are ready (prerequisites done), by priority, with a proposed owner (you, a child profile, a session or the user).
7. **Not checked:** items kept without a code check, tests not run, and areas a child skipped.

Save the full per-item table to `.octocode/backlog-grooming/<date>/report.md` when the board has more than about 40 items, and keep the reply to the summary.
