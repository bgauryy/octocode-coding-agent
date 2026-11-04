Each block is one MCP server: its instructions and a typed function for each tool. To call a tool, replace `*` in the block's `tools` prefix with the function's name and pass the input object.
{{#if deferred}}
Before you call a listed `- name: trigger` tool for the first time, load its schema with the `mcp` tool (intent `tools`, the block's server and the tool's name), since its fields are not shown here.
{{/if}}
{{blocks}}
