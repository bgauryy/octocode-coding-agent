Check-in from Octocode, not from your coordinator's model: you and your coordinator have exchanged no message in the last {{interval}}. Do you need something? Say so now if you are stuck, missing an input or access, repeating a failing approach, or holding a finding your coordinator should not wait for (a wrong premise, a changed scope, a severe problem).
{{#if parentWaits}}
{{> shared/parent-waits.md}} A teammate can still answer a message. Otherwise keep working.
{{else}}
If so, send `agent` type `message` to `parent`, or to the teammate who can settle it, with `replyRequired` when you need an answer. Otherwise keep working.
{{/if}}
Do not reply to this check-in itself.
