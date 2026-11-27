# Working on octocode-agent

Octocode is a coding agent forked from [Pi](https://github.com/earendil-works/pi). `../octocode/packages/octocode-pi-extension` is a migration reference only, never a dependency or second implementation. Follow the [contributor rules](DEVELOPMENT.md#contributor-rules) when changing code.

## Owners

Paths are under `packages/`; ✗ marks forbidden imports or responsibilities.

| Path | Owns; ✗ must not |
| --- | --- |
| `coding-agent/src/core/` | Sessions, resource loading, prompt assembly; `application/` serves terminal and web; session lines use `session-manager/codec.ts` |
| `coding-agent/src/octocode/` | Native tools, permissions, subagents, team, memory, hooks, recovery; `index.ts` composes (later features through `composedLater`, never reorder); `/web` daemon and `workspace/server.ts` fallback |
| `coding-agent/src/octocode/native/` | `prompts/`, `tools/`, `hooks/`, `agents/`, `skills/`; prompts are Markdown (README maps sections); tool descriptions, fields and replies can stay in `tool.ts`; ✗ other prose in `.ts` |
| `coding-agent/src/theme/` | Theme tokens and terminal UI kit; ✗ import `modes/` or `octocode/` |
| `db/src/` | Schema, connections, `queries/` (one module per table family), retention; only `api.ts` is imported |
| `agent/` | Agent loop, tool execution, events; ✗ app configuration or UI policy |
| `ai/` | Providers, model data, auth primitives |
| `tui/` | Terminal components, input, rendering, `@` file index; ✗ depend on the app |
| `mcp/src/` | Only MCP owner: client, configuration, registry, lifecycle, exposure; coding-agent imports only `api.ts`; ✗ others open connections |
| `acp/src/` | ACP `server/` and `client/`, host through `host.ts` ports; ✗ import coding-agent |
| `terminal/src/` | `!`-line completion, parsing, history ranking; ✗ read settings, history or models (`octocode/terminal/` passes them in) |
| `common/src/` | Host-free utilities; ✗ import coding-agent, mcp or acp |
| `contracts/`, `telemetry/` | Serializable contracts, schemas, shared guards; telemetry adds no-op and test recorder; ✗ DB, provider, DOM or permission code |
| `projections/` | Portable frame interpretation (`ApplicationStream`); imports only contracts; ✗ Node, DOM, React, terminal or host code |
| `webview/` | Browser state, transport, rendering; ✗ execute, authenticate or authorize |
| `octocode-agentic-testkit/` | Harness-agnostic behavior tests through adapters; ✗ import other workspaces |

## Essentials

- Read implementation and callers first. Fix behavior in its owner; reuse existing types and helpers. Preserve safety checks, cancellation, cleanup, public contracts and user changes.
- Keep units modular with one owner and no cycles. Fail loudly: catch only expected cases and settle every started promise.
- Yarn owns the only lockfile. Format changed files, run focused tests, then `yarn run check`; run full e2e after a wave of changes. Never weaken tests or run paid evals unrequested.
- Change generators, never generated output. After prompt, tool-description or MCP-preset changes, inspect `.octocode/agent/tmp/agent-prompts/`.
- One full suite or `check` per machine: respect the host lock. Run builds and full suites in the background with output in `.octocode/agent/tmp/`.
- Fix tool errors and wrong turns in their owner, or file a backlog item with trigger and evidence.

References: [development and verification](DEVELOPMENT.md), [glossary](packages/coding-agent/docs/GLOSSARY.md), [documentation](packages/coding-agent/docs/index.md), [designs](docs/FEATURES.md), [scripts](scripts/README.md).
