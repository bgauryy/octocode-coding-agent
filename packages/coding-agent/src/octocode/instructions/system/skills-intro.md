{{#if skillTool}}Use the skill tool, one call per name, to load{{/if}}{{#if bash}}Use bash to load the file of{{/if}}{{#if indirect}}Load the file of{{/if}} every skill {{#if named}}named by the task{{else}}whose description matches the task{{/if}}; several can apply. Load them before other work.
{{#unless named}}
A skill matches when the task does the work its description names, even a small part; a shared word is not enough.
{{/unless}}
