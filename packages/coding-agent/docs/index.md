# octocode-code documentation

Start with the [agent guide](../README.md) and [repository setup](../../../README.md).

## Native agent

- [How to: short recipes for common tasks](how-to.md)
- [All commands](commands.md)
- [Native features and migration from the Pi extension](native-features.md)
- [Web workspace: `/web`, Activity, the backlog board and the Docs view](web-workspace.md)
- [Memory: notes that later sessions reuse](memory.md)
- [Remote access: `/remote`, links, transports and the `octocode remote` CLI](remote.md)
- [Configuration locations and controls](../../../CONFIGURATIONS.md)
- [Add hooks and plugins](../../../PLUGINS.md)
- [Configuration and Pi compatibility](configuration.md)
- [Permissions and source-rule compatibility](permissions.md)
- [Glossary: coordinator, subagent, team, worktree agent and other core terms](GLOSSARY.md)
- [Agent instructions and subagent roles](instructions.md)
- [Settings reference](settings.md)
- [Environment variables](environment-variables.md)
- [CLI modes: text, JSON, RPC and ACP](cli.md)
- [Prompt caching](prompt-caching.md)

## Models and providers

- [Providers](providers.md)
- [Models](models.md)
- [Vendor model discovery](model-discovery.md)
- [Models configuration reference](models-configuration.md)
- [Virtual models](virtual-models.md)
- [Custom providers](custom-provider.md)

## Tools and customization

- [MCP](mcp.md) and its [reference](mcp-reference.md)
- [Hooks: enablement, discovery and supported protocols](hooks.md)
- [Hook events: what each source profile accepts](hook-events.md)
- [Plugins: packaging, discovery and current limitations](plugins.md)
- [Plugins, skills, packages and hooks: design and compatibility checks](../../../docs/PLUGINS_MODS_HOOKS.md)
- [Packages](packages.md)
- [Skills](skills.md)
- [Prompt templates](prompt-templates.md)
- [Themes](themes.md)
- [Keybindings](keybindings.md)
- [Terminal UI](tui.md)
- [Running inside tmux: setup, features and checks](tmux.md)
- [RPC mode: control a headless session over stdin and stdout](rpc.md)
- [Agent Client Protocol: expose Octocode to editors and connect to peers](acp.md)
- [Local session API: send messages to running agents](session-api.md)

## Architecture

- [Every feature, with its owner and documentation](../../../docs/FEATURES.md)
- [Application and interface boundaries](../../../docs/INTERFACE_ARCHITECTURE.md)
- [Agent communication and worker lifecycle](../../../docs/AGENT_COMMUNICATION.md)
- [Execution, permissions and prompts](../../../docs/EXECUTION_AND_PERMISSIONS.md)
- [Editing, verification and debugging](../../../docs/EDITING_AND_DEBUGGING.md)
- [Shared entities and contracts](../../../docs/ENTITIES.md)
- [Context management: request contents, caching and compaction](../../../docs/CONTEXT.md)
- [Agent eval: whether a change ships](../../../scripts/agent-eval/README.md)

## Package references

| Package        | Reference                                                              |
| -------------- | ---------------------------------------------------------------------- |
| coding-agent   | [CLI, sessions and native features](../README.md)                      |
| agent          | [Agent loop, events and tool execution](../../agent/README.md)         |
| ai             | [Provider APIs, authentication and model catalog](../../ai/README.md)  |
| tui            | [Terminal components and rendering](../../tui/README.md)               |
| webview        | [Browser state, transport and rendering](../../webview/README.md)      |
| contracts      | [Shared serializable contracts and schemas](../../contracts/README.md) |
| MCP client API | [Private MCP workspace and public client API](../../mcp/README.md)     |
| telemetry      | [Telemetry contracts and schemas](../../telemetry/README.md)           |
