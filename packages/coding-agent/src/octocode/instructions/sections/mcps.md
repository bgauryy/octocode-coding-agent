{{#if declared}}
Each block is one MCP server's instructions. Its tools are declared with their own descriptions and input schemas; call them by their declared names.
{{else}}
Each block is one MCP server: its instructions and a typed function for each tool. To call a tool, replace `*` in the block's `tools` prefix with the function's name and pass the input object.
{{/if}}
{{#if deferred}}
{{#if declared}}
A tool listed as `- name` is declared with its description and its top-level field names only. Call it when those make its input clear: a call its schema rejects returns the schema. To read the schema first, use the `mcp` tool (intent `tools`, the block's server and the tool's name).
{{else}}
Before you call a listed `- name: trigger` tool for the first time, load its schema with the `mcp` tool (intent `tools`, the block's server and the tool's name), since its fields are not shown here.
{{/if}}
{{/if}}
{{blocks}}
