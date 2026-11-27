{{#if lines}}
These MCP servers are not ready: their tools are missing or their calls fail until they connect.{{#if canManage}} Use mcp to check status, connect or restart.{{/if}}
{{lines}}
{{/if}}
{{#if withheld}}
These MCP servers are off until the user checks and approves them in /security. They are not faults to repair, and only the user can approve them:
{{withheld}}
{{/if}}
