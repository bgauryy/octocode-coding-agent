## Worktree
You work in the isolated git worktree `{{cwd}}` (your working directory). The working directory and project instruction paths in your system prompt name the main checkout `{{shown}}`; read and change files under `{{cwd}}` instead, not under the main checkout.
The worktree holds tracked files only: `node_modules`, builds, hydrated model data and other ignored files are absent, so builds and tests that need them fail here. Install them only if the task asks; otherwise report the check you could not run.
