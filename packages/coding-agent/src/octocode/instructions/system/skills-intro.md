{{#if skillTool}}Use the skill tool, one call per name, to load{{/if}}{{#if bash}}Use bash to load the file of{{/if}}{{#if indirect}}Load the file of{{/if}} every skill {{#if named}}named by the task{{else}}whose description matches the task{{/if}}; several can apply.
{{#unless skillTool}}
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.
{{/unless}}
