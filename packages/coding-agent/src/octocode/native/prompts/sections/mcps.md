{{#if declared}}
Each block is one MCP server's instructions; its tools are declared with their own descriptions and schemas: call them by their declared names.
{{else}}
Each block is one MCP server: its instructions and a typed function per tool. Call a tool by replacing `*` in the block's `tools` prefix with the function's name, passing the input object.
{{/if}}
{{#if deferred}}
{{#if declared}}
A `- name` tool is declared with its description and field names and types only: call it when those make its input clear (a rejected call returns the schema), or read the schema first with `mcp` (intent `tools`, the block's server, the tool's name).
{{else}}
Before first calling a `- name: trigger` tool, load its schema with `mcp` (intent `tools`, the block's server, the tool's name): its fields are not shown here.
{{/if}}
{{/if}}
{{#if onDemand}}
A `- name: trigger` tool is not declared yet: load it with `mcp`{{#unless deferred}} (intent `tools`, the block's server, the tool's name){{/unless}}, or call it by replacing `*` in the block's `tools` prefix with its name. It is declared from then on.
{{/if}}
{{blocks}}
