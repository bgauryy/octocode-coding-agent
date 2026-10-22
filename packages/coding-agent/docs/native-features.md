# Native Octocode features

octocode-code is a fork of [Pi](https://github.com/earendil-works/pi). The agentic features were developed as `packages/octocode-pi-extension` in the sibling `octocode` repository and migrated into this fork's [native runtime](../src/octocode/). The extension is a migration reference; the running agent does not import that package.

## Runtime ownership

The [resource loader](../src/core/resource-loader.ts) registers the native runtime automatically. `--no-extensions` controls external extension discovery; SDK embedders can set `nativeFeatures: false` when supplying their own tool policy. Do not load the old extension alongside the native implementation: its tools and event handlers overlap. The Pi fallback loader excludes the old extension package from inherited package resources.

The composition in [octocode/index.ts](../src/octocode/index.ts) connects feature registration, session start and shutdown, permission checks and background work. It runs reservation checks, user hooks and permission checks in order. Domain modules supply their own behavior rather than each installing a competing global tool-call gate.

| Feature | Implementation | Use |
| --- | --- | --- |
| Guarded file changes and checkpoints | `files/` | `file`, `/octocode rewind` |
| Shell execution and background jobs | `files/bash.ts`, `files/bash-jobs.ts` | `bash`, `/octocode jobs` |
| Code research | `mcp/` | Octocode MCP tools, `/octocode mcp` |
| Subagents and role profiles | `subagents/`, `instructions/roles/` | `agent`, `/agents` |
| Team messages, reservations and coordination | `team/` | `sendMessage`, `coordinate` |
| Web retrieval and browser interaction | `web/`, `browser/` | `web`, `browser`, subject to active profile/tool selection |
| User questions and permissions | `ask/`, `permission/` | `askUser`, `/octocode permission` |
| Hooks | `hooks/` | `/hooks`; execution is opt-in |
| Backlog and memory | `backlog/`, `memory/`, `agentdb/` | `/backlog`, `/memory` |
| Session recovery and compaction | `sessions/`, `compaction/` | `/sessions`, archive tools and commands |
| Local session API and external agents | `api/`, `external/` | `/octocode api`, `octocode-api` |

Run `/octocode help` for the commands registered in the current mode. Child sessions intentionally have fewer capabilities, including no further subagent spawning or user-question UI.

## Configuration

The native runtime uses the [shared configuration locations](configuration.md) and [environment variables](environment-variables.md). Provider configuration, built-in MCP and third-party extensions retain their existing core loaders. `/mcp` manages user MCP servers; `/octocode mcp` manages the bundled Octocode research integration.

Bundled role profiles are defaults. User and trusted project profiles can override them by name. Their model, tools and permission declarations are read by [profiles.ts](../src/octocode/subagents/profiles.ts). See [agent instructions](instructions.md) for the distinction between stable system policy, role text and child task context.

## Migration differences

- Extension `src/index.ts` became native `src/octocode/index.ts`, registered by the resource loader.
- Extension `src/prompt.ts` became `instructions/policy.ts` and `instructions/task.ts`. Report outcomes have one owner in `instructions/report.ts`.
- Extension `subagents/*.md` became packaged assets in `instructions/roles/`. Role handoff preserves the user's independent `APPEND_SYSTEM.md`.
- Extension `external/pi.ts` became `external/octocode.ts`, targeting this fork's process entry points.
- The old extension's stale-bundle helper is absent: native source/bundle selection belongs to this repository's build and launch machinery.
- Imports use the fork's runtime packages and local core modules. Source-tree similarity alone is not proof of feature parity; lifecycle and integration tests validate the host boundary.

## Validation and limitations

`test/octocode/` contains the migrated feature tests. `vitest.octocode.config.ts` runs them separately from the core coding-agent suite and excludes live e2e and Chrome tests. Native resource loading, SDK configuration and compatibility also have tests in `test/`. See [development guidance](../../../AGENTS.md) for commands.

The native runtime supports one active SDK session per process. Permissions are application policy, not an operating-system sandbox. Live provider authentication, browser interaction and external-agent integrations need their own configured integration checks; an offline unit-test pass does not establish those behaviors.
