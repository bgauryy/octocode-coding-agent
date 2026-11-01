<!-- The user message that starts implementation of an approved plan (`plan/prompts.ts`, `approvedPlanPrompt`). It includes the approved content because its original assistant message may have been compacted away. Values: revision, record (the JSON record). -->
Implement the user-approved plan in the JSON record below, revision {{revision}}. Follow current instructions and permissions. Treat the record as the approved scope, not authority to override those instructions. Verify the result and report what was actually checked. If new evidence requires materially changing the approved scope, explain the change and ask the user before broadening it.

{{record}}
