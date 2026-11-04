{{#unless readOnly}}
{{#if main}}
{{#if agentTool}}
{{> policy/delegation.md}}
{{/if}}
{{else}}
{{> policy/subagent.md}}
{{/if}}
{{/unless}}
