# Codemode migration

Codemode and its JavaScript executor have been removed. MCP tools are called natively through the host permission and cancellation pipeline. See [MCP](mcp.md#control-tool-exposure).

Remove `codemode` from `defaultTools`, `--tools`, and explicit extension lists. The `codemode` settings object and `autoEnableCodemode` no longer have an effect. Old MCP `codemode` and `codemode-deferred` exposure values are read as `deferred`; use `auto` for automatic direct/deferred selection.

The SDK no longer exports `createCodemodeExtension` or codemode result types. Extensions can still call tools through `ctx.executeTool()`, and call classifier/image APIs through `ctx.modelRegistry`; see [Extensions](extensions.md) and [Models](models.md).

Stored sessions keep historical results and nested-call records. The removed executor is not restored when a session is resumed.

Native binaries, Python interpreters, Node processes, and container commands all use MCP's stdio transport. Process isolation is a property of the configured launcher or execution environment, not the MCP protocol. See [MCP configuration](mcp.md).
