Load when deciding which agents get an MCP server.

# Assignment

A server is assigned as a unit: its generated file and its tools. The selector for one server is the tool pattern `mcp__<server>__*`, the same in `--tools`, a profile's `tools:` and `excludeTools:`. The `defaultTools` setting takes exact tool names (`+mcp__<server>__<tool>`), not patterns.

| Goal                   | Configuration                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Every agent (default)  | Nothing: the server is in every agent's default selection                                                                  |
| Only some subagents    | `"defaultActive": false` on the server in `mcp.json`, and `mcp__<server>__*` in the `tools:` of each profile that needs it |
| The main agent as well | `--tools` with `mcp__<server>__*`, or a workspace override `{ "mcpServers": { "<server>": { "defaultActive": true } } }`   |
| No agent               | `"enabled": false`; to hide single tools, `"toolExposure": { "<tool>": "hidden" }`                                         |

- With `defaultActive: false`, only an entry that names the server selects it: a broad wildcard such as `*` or `mcp__*` does not.
- A session whose selection does not reach a server never starts it; `/mcp` shows it as `not selected`.
- `defaultActive`, `enabled`, `exposure` and `toolExposure` are control-only keys: a workspace `mcp.json` may set them for a server defined globally or shipped by Octocode.
- The built-in `browser` server is assigned this way: only the `browser` subagent selects it, and the main agent is told to delegate browser work to that subagent.

## Cache effect

- An assigned server's file is part of the cached base of every agent that selects it, ahead of project context, so sessions in other projects and on other days read it from cache.
- Subagents of one profile build the same prefix, so the second one reads what the first one wrote.
- Each assigned server adds its whole file to every selecting agent's prompt. Assign a large server only to the agents that use it, and let the others delegate to them.
