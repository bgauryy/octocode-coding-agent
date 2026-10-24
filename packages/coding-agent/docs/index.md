# octocode-code documentation

Start with the [agent guide](../README.md) and [repository setup](../../../README.md).

## Native agent

- [All commands and aliases](commands.md)
- [Native features and migration from the Pi extension](native-features.md)
- [Configuration locations and controls](../../../CONFIGURATIONS.md)
- [Configuration and Pi compatibility](configuration.md)
- [Permissions and source-rule compatibility](permissions.md)
- [Agent instructions and subagent roles](instructions.md)
- [Environment variables](environment-variables.md)
- [Prompt caching](prompt-caching.md)

## Models and providers

- [Providers](providers.md)
- [Models](models.md)
- [Models configuration reference](models-configuration.md)
- [Virtual models](virtual-models.md)
- [Custom providers](custom-provider.md)

## Tools and customization

- [MCP](mcp.md)
- [Optional native debugger](debugging.md)
- [Extensions](extensions.md)
- [Hooks: enablement, discovery and supported protocols](hooks.md)
- [Plugins: packaging, discovery and current limitations](plugins.md)
- [Plugins, skills, extensions and hooks: compatibility matrix and implementation plan](../../../docs/PLUGINS_MODS_HOOKS.md)
- [Packages](packages.md)
- [Skills](skills.md)
- [Prompt templates](prompt-templates.md)
- [Themes](themes.md)
- [Keybindings](keybindings.md)
- [Terminal UI](tui.md)
- [SDK](sdk.md)
- [Agent Client Protocol: expose Octocode to editors](acp.md)

## Architecture

- [Application and interface boundaries](../../../docs/INTERFACE_ARCHITECTURE.md)
- [Native feature architecture and flows](../../../docs/FEATURES.md)
- [Shared entities and contracts](../../../docs/ENTITIES.md)
- [Data and presentation architecture](../../../docs/DATA_PRESENTATION.md)
- [Browser workspace review](../../../docs/WEBVIEW_REVIEW.md)

## Package references

| Package | Reference |
| --- | --- |
| coding-agent | [CLI, sessions, native features and SDK](../README.md) |
| agent | [Agent loop, events and tool execution](../../agent/README.md) |
| ai | [Provider APIs, authentication and model catalog](../../ai/README.md) |
| tui | [Terminal components and rendering](../../tui/README.md) |
| webview | [Browser state, transport and rendering](../../webview/README.md) |
| contacts | [Shared serializable contracts and schemas](../../contacts/README.md) |
| mcp | [Standalone MCP client and transports](../../mcp/README.md) |
| telemetry | [Telemetry contracts and schemas](../../telemetry/README.md) |
