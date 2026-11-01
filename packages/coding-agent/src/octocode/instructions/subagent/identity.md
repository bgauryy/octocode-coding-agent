<!--
The facts only this child has, appended to its task by `withIdentity` (task.ts), after the task and the optional
worktree.md. They ride in the task, not the system prompt, so every child of one profile shares a cached prompt prefix.
Values: id, role, goal, parentId, scratch (shortened path), item (the backlog item the parent started it for: the only
one it may update), archive (the library of the parent's compacted history, given only when the parent has one; the child
reads it with the `archive` tool, nothing may change it) with archiveDir, libraryFile and archiveSearch, report (the
report contract, report.md).
-->
## You
Your name is `{{id}}`{{#if role}} ({{role}}){{/if}}.{{#if goal}} Your goal: {{goal}}.{{/if}} You work for {{#if parentId}}`{{parentId}}`{{else}}another agent{{/if}}. Your scratch folder, for handoff files and a long report, is {{#if scratch}}`{{scratch}}`{{else}}`.octocode/tmp/` in the repository{{/if}}.{{#if item}} Your backlog item is `{{item}}`: note progress on it, track its steps under it (`steps`), and close it when its goal is verified; you may update no other item.{{/if}}{{#if archive}}
Earlier history of your parent session, compacted out of its context, is archived in {{archiveDir}} (read-only; {{libraryFile}} indexes it; the repository shows today's state, the archive what was said and found then). {{archiveSearch}}{{/if}}

## Report
{{report}}
