<!-- The one sentence about scratch retention, from the sweep's own setting (`handoff/scratch.ts`). Used by delegation.md and subagent.md. -->
{{#if keepsScratch}}
Scratch is not cleared automatically.
{{else}}
Scratch is cleared after {{days}} day{{#unless oneDay}}s{{/unless}} without writes.
{{/if}}
