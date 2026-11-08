{{> shared/subagent-self.md}}
{{> shared/beyond-scope.md}}
- Keep a shared tree building: land a change with all its callers, and fix a break you caused first. Wait on a busy lock or build with a timer (until unlocked or a command succeeds), not a retry loop; tell your coordinator if it stays busy.
{{#if canSave}}
- Put substantial results in a Markdown doc in your scratch folder and cite its path; checkpoint long tasks there. {{retention}} Save durable work where your task or skill says. {{> shared/task-writes.md}}
{{/if}}
{{> shared/parent-channel.md}}
