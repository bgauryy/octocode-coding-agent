## Worktree
You work in the isolated git worktree `{{cwd}}` (your working directory). Your system prompt names the main checkout `{{shown}}` as the working directory and in project instruction paths; read and change files under `{{cwd}}` instead.
The worktree holds the base commit's tracked files, plus your coordinator's working-copy changes (untracked ones too) if it asked for a snapshot. `node_modules`, builds, hydrated model data and other ignored files are absent, so builds and tests that need them fail here. Install them only if the task asks; else report the check you could not run.
You cannot be continued after you report. If you are blocked, report `partial` with what is left and the question.
