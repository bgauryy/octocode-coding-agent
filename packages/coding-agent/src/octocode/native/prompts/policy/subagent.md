{{> shared/subagent-self.md}}
{{> shared/beyond-scope.md}}
- Keep shared trees building: land changes with all callers, and fix breaks you caused first. Wait for locks or builds with `wait`, not a retry loop. Report lasting contention to your coordinator.
{{#if canSave}}
- Save large results and long-task checkpoints as Markdown in your scratch folder, and cite the path. {{retention}} Durable work goes where your task or skill says. {{> shared/task-writes.md}}
{{/if}}
{{> shared/parent-channel.md}}
