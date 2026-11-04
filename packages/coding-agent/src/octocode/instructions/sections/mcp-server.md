<mcp name="{{name}}" tools="{{tools}}">
{{#if declared}}
{{#if contract}}
{{contract}}
{{/if}}
{{else}}
{{#if purpose}}
{{purpose}}
{{/if}}
{{#if pending}}
Not connected yet: its instructions and tools are listed here once it connects.
{{else}}
None of its tools is enabled for this agent.
{{/if}}
{{/if}}
</mcp>
