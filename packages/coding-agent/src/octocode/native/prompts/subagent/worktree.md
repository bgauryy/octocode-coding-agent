## Worktree
You work in the isolated git worktree `{{cwd}}` (your working directory). Your system prompt names the main checkout `{{shown}}` in its paths; use the same paths under `{{cwd}}`.
The worktree holds the base commit's tracked files, plus your coordinator's working-copy changes (untracked ones too) if it asked for a snapshot. The checkout's `node_modules` are linked in, so builds and tests run here{{#if unlinked}}, except: {{unlinked}} Report any check that needs what is missing{{else}}; build output and hydrated model data are not{{/if}}.
Your report ends this run; your coordinator can resume it with a follow-up task. If you are blocked by a decision or missing input, report `blocked` with what is done and the one question.
