## Worktree
You work in the isolated git worktree `{{cwd}}` (your working directory). The working directory and project instruction paths in your system prompt name the main checkout `{{shown}}`; read and change files under `{{cwd}}` instead, not under the main checkout.
The worktree holds the base commit's tracked files, plus your coordinator's working-copy changes (untracked ones too) when it asked for a snapshot: `node_modules`, builds, hydrated model data and other ignored files are absent, so builds and tests that need them fail here. Install them only if the task asks; otherwise report the check you could not run.
You cannot be continued after you report: when you are blocked, report `partial` with what is left and the question.
