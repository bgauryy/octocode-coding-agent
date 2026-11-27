{{#if declared}}
Each block gives one MCP server's instructions. Use the declared tool names.
{{else}}
Each block is one MCP server: its instructions and a typed function per tool. Call a tool by replacing `*` in the block's `tools` prefix with the function's name, passing the input object.
{{/if}}
{{#if deferred}}
A declared tool listed as {{#if declared}}`- name`{{else}}`- name: trigger`{{/if}} has a thin schema. Call it directly when clear. If nested fields, path bases, operation requirements or defaults are unclear, read its full contract with `mcp` (intent `tools`, server and tool name).
{{/if}}
{{#if onDemand}}
A `- name: trigger` tool is not declared yet: load it with `mcp`{{#unless deferred}} (intent `tools`, the block's server, the tool's name){{/unless}}, or call it by replacing `*` in the block's `tools` prefix with its name. It is declared from then on.
{{/if}}
{{blocks}}
