Check-in from Octocode, not from your parent's model: you and your parent have exchanged no message in the last {{interval}}. Do you need something?
{{#if parentWaits}}
Your parent waits for your report and reads messages only with your report, so it cannot answer during this run. If you need a decision, or found that a premise of your task is wrong, finish with a `blocked` report that says so. Otherwise keep working.
{{else}}
If you need a decision, or found that a premise of your task is wrong, send `agent` type `message` to `parent`, with `replyRequired` when you need an answer. Otherwise keep working.
{{/if}}
No reply is needed.
