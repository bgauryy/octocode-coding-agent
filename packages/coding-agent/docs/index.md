# octocode-code documentation

Start with the [agent guide](../README.md) and [repository setup](../../../README.md).

## Native agent

- [All commands](commands.md)
- [Native features and migration from the Pi extension](native-features.md)
- [Remote access: `/remote`, links, transports and the `octocode remote` CLI](remote.md)
- [Configuration locations and controls](../../../CONFIGURATIONS.md)
- [Add hooks, plugins and extensions](../../../PLUGINS.md)
- [Configuration and Pi compatibility](configuration.md)
- [Permissions and source-rule compatibility](permissions.md)
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

- [MCP](mcp.md)
- [Codemode migration](codemode.md)
- [Optional native debugger](debugging.md)
- [Extensions](extensions.md)
- [Hooks: enablement, discovery and supported protocols](hooks.md)
- [Hook events: what each source profile accepts](hook-events.md)
- [Plugins: packaging, discovery and current limitations](plugins.md)
- [Plugins, skills, extensions and hooks: compatibility matrix and implementation plan](../../../docs/PLUGINS_MODS_HOOKS.md)
- [RFC: align hooks, plugins and extensions under one source model](../../../docs/RFC_HOOKS_PLUGINS_EXTENSIONS.md)
- [Packages](packages.md)
- [Skills](skills.md)
- [Prompt templates](prompt-templates.md)
- [Themes](themes.md)
- [Keybindings](keybindings.md)
- [Terminal UI](tui.md)
- [Running inside tmux: setup, features and checks](tmux.md)
- [SDK](sdk.md)
- [RPC mode: control a headless session over stdin and stdout](rpc.md)
- [Agent Client Protocol: expose Octocode to editors and connect to peers](acp.md)
- [Local session API: send messages to running agents](session-api.md)

## Architecture

- [Application and interface boundaries](../../../docs/INTERFACE_ARCHITECTURE.md)
- [Agent communication and worker lifecycle](../../../docs/AGENT_COMMUNICATION.md)
- [Native feature architecture and flows](../../../docs/FEATURES.md)
- [Shared entities and contracts](../../../docs/ENTITIES.md)
- [Context management: request contents, caching and compaction](../../../docs/CONTEXT.md)
- [Browser workspace review](../../../docs/WEBVIEW_REVIEW.md)
- [Provider protocol and authentication audit](../../../docs/PROVIDER_PROTOCOL_AUDIT.md)

## Package references

| Package        | Reference                                                             |
| -------------- | --------------------------------------------------------------------- |
| coding-agent   | [CLI, sessions, native features and SDK](../README.md)                |
| agent          | [Agent loop, events and tool execution](../../agent/README.md)        |
| ai             | [Provider APIs, authentication and model catalog](../../ai/README.md) |
| tui            | [Terminal components and rendering](../../tui/README.md)              |
| webview        | [Browser state, transport and rendering](../../webview/README.md)     |
| contacts       | [Shared serializable contracts and schemas](../../contacts/README.md) |
| MCP client API | [Private MCP workspace and public client API](../../mcp/README.md)    |
| telemetry      | [Telemetry contracts and schemas](../../telemetry/README.md)          |
