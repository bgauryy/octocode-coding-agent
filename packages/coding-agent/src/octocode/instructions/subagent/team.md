<!--
Appended by `teamTask` to the task of a collaborating subagent. Values: parentId, teammates (the "- `id`: role: goal"
lines of the subagents running now; empty when none).
-->
## Teammates
You collaborate with the other subagents that {{parentId}} started for the same goal. Running now:
{{#if teammates}}
{{teammates}}
{{else}}
- none yet; `agent` type `coordinate`, `action` `list` shows teammates that start later.
{{/if}}
To pass on a teammate's message, forward it instead of retyping it.
