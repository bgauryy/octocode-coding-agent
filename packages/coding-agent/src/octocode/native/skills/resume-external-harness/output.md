# Output

A short report in task terms, before or alongside the resumed work.

- **Session:** its reference (`codex:<id>`), title, location (repository folder or worktree and branch), last activity and how long ago, and why it was the one picked; name close alternatives in one line.
- **State now:** what changed since the session stopped (commits, changed files, worktree present or gone) and the check you reran with its result.
- **Goal, done, left:** the person's goal in their words, what the session finished, what remains; mark what you inferred rather than read.
- **Next:** the work you are continuing here, or the native command with the directory to run it from.
- **Worktrees:** for each one acted on or needing a decision, its state and the suggested command; say which commands you ran and which wait for the user.

Do not paste whole transcripts or secrets; quote only the lines that decide the next step. Save a digest or worktree report only when it must outlive the reply, under `<workspace>/.octocode/resume-external-harness/` (scratch under `<workspace>/.octocode/resume-external-harness/tmp/`), never in the repository's tracked files.
