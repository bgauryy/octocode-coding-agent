<!--
The worktree an isolated child works in, appended to its task. Its system prompt shows the main checkout's paths, which
are the same for every child, so the real location rides in the task. Files under the main checkout are not its copy.
Values: cwd (the worktree working directory), shown (the main checkout path its prompt names).
-->
## Worktree
You work in the isolated git worktree `{{cwd}}` (your working directory). The working directory and project instruction paths in your system prompt name the main checkout `{{shown}}`; read and change files under `{{cwd}}` instead, not under the main checkout.
