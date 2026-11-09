# Hook Events

<!-- This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references. -->

This page lists every hook event Octocode implements and what each source profile accepts there. Each hook file runs under the profile of the host that defines its format; the profiles are:

- **Native**: `<Octocode home>/hooks.json`, `.octocode/hooks.json`.
- **Claude**: Claude `settings.json` files and Claude plugins.
- **Codex**: Codex `hooks.json`, `config.toml` and Codex or portable plugins.

See [Hooks](hooks.md) for discovery, trust, the input each event receives and the output it accepts.

## Events and handler types

| Event | Native | Claude | Codex | Behavior |
|---|---|---|---|---|
| `PreToolUse` | `command` | `command`, `http`, `prompt`, `mcp_tool` | `command`, `mcp_tool` | Denies calls, supplies context and applies supported source-profile rewrites before normal permission checks. |
| `PermissionRequest` | — | `command`, `http`, `prompt`, `mcp_tool` | `command`, `mcp_tool` | Allows or denies an approval that would otherwise be asked; an allow lasts for that request. |
| `PostToolUse` | `command` | `command`, `http`, `prompt`, `mcp_tool` | `command`, `mcp_tool` | Native/Claude append feedback; Codex can replace results. Successful file queries are handled individually. |
| `PostToolUseFailure` | — | `command`, `http`, `prompt`, `mcp_tool` | — | Observes failures and can add context. |
| `PostToolBatch` | — | `command`, `http`, `prompt`, `mcp_tool` (no matcher) | — | Observes the completed batch once; blocking prevents the next model request. |
| `SessionStart` | `command` | `command`, `mcp_tool` | `command`, `mcp_tool` | Supplies context for the next prompt, including after compaction. |
| `SubagentStart` | — | `command`, `http`, `mcp_tool` | `command`, `mcp_tool` | Supplies child context when child hooks are enabled. |
| `SubagentStop` | — | `command`, `http`, `prompt`, `mcp_tool` | `command`, `mcp_tool` | Gates child completion when child hooks are enabled. |
| `Interrupt` | — | — | `command`, `mcp_tool` (1 s default, no matcher) | Observes an explicitly interrupted main turn after cancellation; cannot continue it. |
| `SessionEnd` | `command` (1.5 s default) | `command`, `http`, `mcp_tool` (1.5 s default) | `command` (1 s default) | Observes supported termination reasons within a separate cleanup deadline. |
| `AgentOn` | `command` (1.5 s default) | — | — | Octocode only: observes an agent of this process joining the team (main session or child); the matcher is its role. Cannot block or add context. |
| `AgentOff` | `command` (1.5 s default) | — | — | Octocode only: observes an agent this process retired from the team, within a separate 1.5 s deadline; the matcher is the end reason (completed, failed, stopped-user, stopped-parent, parent-gone, crashed, left). Cannot block or delay the exit. |
| `UserPromptSubmit` | — | `command`, `http`, `prompt`, `mcp_tool` (30 s default, no matcher) | `command`, `mcp_tool` (no matcher) | Gates normal prompts, steering and follow-ups; Claude runs at admission, Codex when input is consumed. |
| `PreCompact` | `command` | `command`, `http`, `mcp_tool` | `command`, `mcp_tool` | Native is observational; supported source-profile vetoes reach the compaction owner. |
| `PostCompact` | — | `command`, `http`, `mcp_tool` | `command`, `mcp_tool` | Claude observes; Codex can stop continuation after compaction. |
| `Stop` | `command` | `command`, `http`, `prompt`, `mcp_tool` (no matcher) | `command`, `mcp_tool` (no matcher) | Can request continuation; explicit source-profile termination takes precedence. |
| `StopFailure` | — | `command`, `http`, `mcp_tool` | — | Observes final error settlement; output cannot control the run. |
| `Notification` | `command` | `command`, `http`, `mcp_tool` | — | Background observer; cannot block. Explicit Claude `async: true` can defer context. |
| `PreMessageSend` | `command` | — | — | Octocode message gate; can deny or ask before sending. |
| `PostMessageReceive` | `command` | — | — | Observes delivery; cannot rewrite messages or request a reply. |

## Host metadata in the input

Native input carries no host metadata. Source profiles add these fields when the value is available; `agent` means `agent_id` and `agent_type` inside a subagent.

| Event | Claude | Codex |
|---|---|---|
| `PreToolUse` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id`, `agent` |
| `PermissionRequest` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id`, `agent` |
| `PostToolUse` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id`, `agent` |
| `PostToolUseFailure` | `permission_mode`, `agent` | — |
| `PostToolBatch` | `permission_mode`, `agent` | — |
| `SessionStart` | `permission_mode`, `agent`, `model` | `model`, `permission_mode` |
| `SubagentStart` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id` |
| `SubagentStop` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id` |
| `Interrupt` | — | `model`, `permission_mode`, `turn_id` |
| `SessionEnd` | `permission_mode`, `agent` | none |
| `UserPromptSubmit` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id`, `agent` |
| `PreCompact` | `permission_mode`, `agent` | `model`, `turn_id`, `agent` |
| `PostCompact` | `permission_mode`, `agent` | `model`, `turn_id`, `agent` |
| `Stop` | `permission_mode`, `agent` | `model`, `permission_mode`, `turn_id` |
| `StopFailure` | `permission_mode`, `agent` | — |
| `Notification` | `permission_mode`, `agent` | — |

## Command handler fields

- **Native** (default timeout 60 s): `type`, `command`, `timeout`, `failClosed`, `statusMessage`.
- **Claude** (default timeout 600 s): `type`, `command`, `timeout`, `failClosed`, `statusMessage`, `args`, `shell`, `onFailure`, `async`, `asyncRewake`.
- **Codex** (default timeout 600 s): `type`, `command`, `timeout`, `failClosed`, `statusMessage`, `commandWindows`, `async`, `additionalContextLimit`.

Other fields reject the handler with a diagnostic in `/harness hooks`. No timeout can exceed 600 seconds.

## Upstream events not implemented yet

These events are documented by the upstream host but not implemented in Octocode yet. A hook file that declares one is loaded without it, and `/harness hooks` reports it as not implemented.

- **Claude Code**: `Setup`, `UserPromptExpansion`, `PermissionDenied`, `MessageDisplay`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`.

- **Codex**: `PreModelRequest`, `PostModelRequest` (in Codex source, not yet in its documentation).
