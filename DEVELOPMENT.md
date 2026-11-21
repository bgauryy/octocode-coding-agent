# Developing octocode-agent

For contributors. To use Octocode, read the [README](README.md). Rules for changing code, owners and generated files: [AGENTS.md](AGENTS.md).

Octocode is a fork of [Pi](https://github.com/earendil-works/pi): Pi's agent loop, providers and terminal UI plus native Octocode features (code research, guarded edits, subagents, collaboration, browser work, memory, recovery). The native features live in `packages/coding-agent/src/octocode/` and load automatically.

## Run from source

Needs Node.js 24.15 or newer within Node 24 (`.node-version` pins the line) and the sibling `octocode` repository checked out at `../octocode` on the `octocode-20.0.0` branch (its default branch lacks the needed packages). `packages/coding-agent/package.json` links the sibling packages `octocode`, `octocode-mcp`, `octocode-native` and `octocode-chrome-devtools` with `link:`; build them first, native binaries included.

```sh
yarn install --immutable
yarn run hydrate:model-data   # downloads the provider model catalog
yarn start                    # run from source; `yarn start --help` lists options
```

Inside the app: `/providers` connects an account, `/model` picks a model, `/help` lists commands.

| Command                      | Does                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `yarn start research --help` | The research CLI (`octocode`; `octocode-cli` in agent shells, where `octocode` is the agent) |
| `yarn start native --help`   | The native helper CLI                                                                        |
| `yarn run build:offline`     | Builds every workspace after hydration; run `node packages/coding-agent/dist/bundle/cli.js`  |
| `yarn run build`             | Refreshes model data, then builds                                                            |

## Verify

```mermaid
flowchart LR
  edit[Edit] --> fmt["yarn oxfmt files"] --> focus["Focused vitest"] --> check["yarn run check"] --> e2e["test:e2e after a wave of changes"]
```

| Command                                                                                 | Does                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn run check`                                                                        | Typecheck, Oxlint, format check, browser smoke, workspace subpaths, bundle and favicon freshness, package, database and MCP boundaries, paid-test isolation, generated reference pages, Knip; rewrites nothing                                                                                                                                                       |
| `yarn oxfmt <files>`                                                                    | Formats those files (`yarn run format` formats everything)                                                                                                                                                                                                                                                                                                           |
| `yarn vitest run --config vitest.octocode.config.ts [paths]` in `packages/coding-agent` | Native suite (`test/octocode/`); `yarn run test:changed` runs only tests for changed files                                                                                                                                                                                                                                                                           |
| `yarn vitest run [paths]` in `packages/coding-agent`                                    | Core suite                                                                                                                                                                                                                                                                                                                                                           |
| `yarn workspace @octocodeai/octocode-agent run test:e2e`                                | Real sessions on a scripted model, no network; holds the prompt-size ceilings. `OCTOCODE_E2E_CHROME=1` adds the headless-Chrome browser cases, `OCTOCODE_E2E_SOAK=1` the full 320-turn soak                                                                                                                                                                          |
| `yarn workspace @octocodeai/octocode-agent run test:architecture`                       | Layering rules in the coding-agent                                                                                                                                                                                                                                                                                                                                   |
| `yarn workspace <name> run test:live`                                                   | Paid tests (`*.live.test.ts`: real provider or model requests, so they cost money) of that workspace; no default `test` script, `./test.sh` or `yarn run check` runs them, whatever keys the shell exports. The tests also need their own credentials and flags (provider API keys, `TESTKIT_LIVE=1`); `ai`, `coding-agent` and `octocode-agentic-testkit` have them |
| `yarn run test:scripts`                                                                 | Node tests for `scripts/` (not `scripts/agent-eval/`)                                                                                                                                                                                                                                                                                                                |
| `yarn run test:agentic`                                                                 | Agent-behavior suites: the agentic testkit's free tests and `scripts/agent-eval/` tests; not part of `./test.sh`                                                                                                                                                                                                                                                     |
| `./test.sh`                                                                             | Every code and UI test with isolated home, config, credentials and temp dir (needs `fd`, `rg`); `yarn run test` is its workspace runner                                                                                                                                                                                                                              |
| `yarn run test:tmux`, `yarn run test:mcp-conformance`                                   | tmux and MCP conformance suites                                                                                                                                                                                                                                                                                                                                      |
| `yarn run check:unused`                                                                 | Knip: unused files, exports and dependencies. `knip.jsonc` lists public APIs and dynamic entry points; verify a finding against them before deleting                                                                                                                                                                                                                 |

- Paid tests live in `*.live.test.ts`; every vitest config excludes them unless `OCTOCODE_LIVE_TESTS=1` (set by `test:live`), and `yarn run check:live-tests` fails when a default run would collect one or a test gated on provider credentials. Local Ollama tests are not paid.
- Run builds and full suites in the background; write long output to `.octocode/agent/tmp/`. Never run two builds or generators at once.
- One full run at a time on this machine, across sessions, checkouts and worktrees: a whole vitest suite (no file filters) or `yarn run check` waits while another holds `~/.octocode/locks/full-run` and prints the holder (label, pid, session, folder, and the agent, backlog item and bash job when the `bash` tool started the run). Runs that name test files never wait. A killed holder's lock is taken over at once; `OCTOCODE_RUN_LOCK=off` skips it. To wait for the lock, poll `node scripts/full-run-lock.ts --status` (exit 0 when free; it clears a dead holder's lock) rather than the lock file. The core suite, like native and e2e, uses at most 4 workers.
- After browser source changes run `yarn run generate:workspace`. After prompt, tool description or MCP preset changes run `yarn workspace @octocodeai/octocode-agent run generate:prompts` and read `.octocode/agent/tmp/agent-prompts/`.
- Harness-based session tests: [suite rules](packages/coding-agent/test/suite/README.md).
- Known flakes: `team-interpreter-parsed` "gates a 2000-stage pipeline quickly" (400 ms limit) under heavy load; the real-browser e2e can leave a Chrome process behind.
- `octocode-test.sh` runs the agent from source; it is a launcher, not a suite.

## Release

`@octocodeai/octocode-agent` is published with every other workspace compiled into its one bundle, except the agentic
testkit, which publishes on its own (below).

```mermaid
flowchart LR
  A["yarn run publish:dry or publish"] --> B["Write manifest into the tarball\nwith exact octocodeRelease versions"]
  B --> C["Add docs/ as docs/project/\nminus internal reviews and audits"]
  C --> D["Install the tarball from npm,\nrun a real session on a scripted model"]
  D -->|all pass| E[Publish]
  D -->|any failure| F[Refuse]
```

`publish:dry` rehearses; `publish` also requires a clean tree and dependency versions on npm. Local packaging (`pack:packages`, `release:local`) turns `link:` and `file:` dependencies into absolute `file:` references in disposable artifacts: they depend on the sibling checkout and are not portable. What each script does: [scripts/README.md](scripts/README.md).

### Publish the agentic testkit

`@octocodeai/octocode-agentic-testkit` depends on no workspace and ships its own `dist`, `src`, examples and docs.

```sh
cd packages/octocode-agentic-testkit
yarn pack --dry-run        # prepack builds, rewrites declaration specifiers and runs check:consumer
npm publish --access public
```

Bump `version` and move the CHANGELOG's Unreleased entries under it first. The `agentic-testkit` GitHub workflow runs
the same checks on Linux and macOS with Node 24 and 26.

### Validate a registry release candidate

Staging runs after `yarn run build:offline`, rewrites no development manifest and publishes nothing. Supply a reviewed JSON map: `schemaVersion: 1` and a `packages` object keyed by dependency name, each with an exact `version`, its `sourceRevision` and the registry's `sha512-…` `integrity` (include reviewed native platform packages and other sibling transitive packages). Seed a disposable registry with the candidate and the reviewed sibling tarballs, then:

```sh
node scripts/stage-registry-release.mjs --prepare --map /path/to/map.json \
  --registry http://127.0.0.1:4873/ --out /tmp/octocode-registry-candidate

# once the registry serves the exact tarballs:
node scripts/stage-registry-release.mjs --verify --map /path/to/map.json \
  --registry http://127.0.0.1:4873/ --out /tmp/octocode-registry-candidate
```

| Phase       | Does                                                                                                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prepare` | Saves tarballs, checksums and the map digest in `candidate.json`                                                                                                                                                                                                                                                                                    |
| `--verify`  | Checks registry metadata and integrities, creates an installer lock under the output directory, installs the single staged tarball in a clean consumer, and checks both CLI entries, public imports, roles, research skills, model data and `--help` paths with isolated configuration. Keeps its bytes on failure; discards any prior fixture lock |

A disposable-registry result is not a production lock: after the dependency tarballs are published, rerun `--verify --registry https://registry.npmjs.org/` on the same tarballs, then review and copy the verified lock through the release process. The command never publishes and refuses to write a fixture lock into the production installer-lock directory. Check supported OS/CPU/libc variants separately so native binaries load. `yarn run check:package-install` covers the local multi-tarball graph instead.

## Packages

`coding-agent` is the only published package (`@octocodeai/octocode-agent`); every other workspace compiles into its one bundle. A **library** builds its own `dist/`. A **hosted** workspace (`octocodeSource` in its manifest) has no build: its sources compile straight into coding-agent, which reaches it only through its `api.ts` or `host.ts`.

| Package                                                                 | Kind     | Owns                                                                                                                                                                    |
| ----------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [coding-agent](packages/coding-agent/README.md)                         | CLI      | Entry and modes (`src/main/`, `src/modes/`), sessions and prompt assembly (`src/core/`), native tools, permissions, subagents, team, memory and hooks (`src/octocode/`) |
| [agent](packages/agent/README.md)                                       | library  | The agent loop: streams a model response, runs tool calls, queues steering, emits events                                                                                |
| [ai](packages/ai/README.md)                                             | library  | Providers, model catalog, auth resolution, streaming, token and cost tracking                                                                                           |
| [tui](packages/tui/README.md)                                           | library  | Terminal components, input, differential renderer; prebuilt clipboard and modifier-key helpers                                                                          |
| [tui-ink](packages/tui-ink/README.md)                                   | library  | Opt-in Ink + React renderer (`OCTOCODE_UI=ink`): screen modes, input bridge, clock, theme, `<Legacy>` bridge over `tui` components; `tui` never imports it              |
| [webview](packages/webview/README.md)                                   | library  | The `/web` page: views, store, transport; never executes or authorizes                                                                                                  |
| [projections](packages/projections/README.md)                           | library  | Portable frame interpretation every interface shares: ordering, snapshots, receipts, resync; imports only contracts, no Node, DOM or host code                          |
| [contracts](packages/contracts/README.md)                               | library  | TypeBox schemas and types that cross a package or interface boundary                                                                                                    |
| [common](packages/common/README.md)                                     | library  | Host-free utilities: JSON, paths, atomic writes, process helpers, redaction, web guard                                                                                  |
| [telemetry](packages/telemetry/README.md)                               | library  | Span and metric contracts with a no-op context                                                                                                                          |
| [mcp](packages/mcp/README.md)                                           | hosted   | MCP client, transports, configuration, registry, lifecycle, default servers                                                                                             |
| [acp](packages/acp/README.md)                                           | hosted   | ACP server for editors, ACP client for external agents                                                                                                                  |
| [db](packages/db/README.md)                                             | hosted   | SQLite schema, queries, writer workers, history retention                                                                                                               |
| [terminal](packages/terminal/README.md)                                 | hosted   | `!`-line shell completion and history ranking                                                                                                                           |
| [octocode-agentic-testkit](packages/octocode-agentic-testkit/README.md) | test kit | Behavior tests for any agent harness: suites with runs and USD caps, scripted models, MCP mocks, guards, traces, matchers; no workspace depends on it                   |

Allowed imports, enforced by `yarn run check:boundaries` (`PACKAGE_POLICY` in `scripts/check-package-boundaries.mjs`). Not drawn: `common` and `contracts`, which most packages use.

```mermaid
flowchart LR
  CA[coding-agent] --> AGENT[agent] --> AI[ai] --> TEL[telemetry]
  CA --> AI
  CA --> TUI[tui]
  CA --> INK[tui-ink] --> TUI
  CA --> WEB[webview] --> PROJ[projections]
  CA -.->|hosts| MCP[mcp]
  CA -.->|hosts| ACP[acp]
  CA -.->|hosts| DB[db]
  CA -.->|hosts| TERM[terminal]
  MCP --> AGENT
  MCP --> AI
  MCP --> TUI
  ACP --> MCP
  ACP --> AI
```

### From command to tool call

```mermaid
flowchart TD
  CLI["octocode: cli.ts, main/<br/>arguments, folder trust, settings"] -->|"--mode acp"| BROKER["acp broker<br/>an RPC worker per session"]
  CLI --> RT["Runtime (core/)<br/>session manager, models, resource loader"]
  RT -->|"registers built-in features:<br/>octocode/, mcp, llama.cpp"| FEAT["Tools, commands, event handlers"]
  RT --> INT["Interactive: modes/interactive on tui"]
  RT --> PRINT["Print: text or JSON Lines"]
  RT --> RPC["RPC: stdin and stdout"]
  BROKER --> RPC
  INT --> SES["AgentSession (core/agent-session/)"]
  PRINT --> SES
  RPC --> SES
  SES --> LOOP["agent: Agent loop"]
  LOOP <--> PROV["ai: provider stream"]
  LOOP -->|tool call| GATE["tool_call gate (octocode/)<br/>invariants, hooks, permission mode"]
  GATE -->|allowed| TOOL["Tool: file, bash, web, agent, MCP"]
  GATE -->|refused| LOOP
  TOOL --> LOOP
  SES --> STORE[("JSONL transcript;<br/>db: workspaces.db, transcripts.db")]
  SES --> VIEWS["Application service:<br/>terminal, /web (webview)"]
```

Each step in depth: [request flows](packages/coding-agent/docs/harness-flows.md), [every tool call](docs/EXECUTION_AND_PERMISSIONS.md), [terminal, web and the host](docs/INTERFACE_ARCHITECTURE.md), [subagents and team mail](docs/AGENT_COMMUNICATION.md), [stored entities](docs/ENTITIES.md).

### Where docs live

| Need                                                  | Page                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Install and use Octocode                              | [README](README.md), [user guide](packages/coding-agent/README.md)       |
| Every user page (ships in the package)                | [Documentation index](packages/coding-agent/docs/index.md)               |
| Designs that cross packages (ship as `docs/project/`) | [Features and owners](docs/FEATURES.md) and its sibling pages in `docs/` |
| A library's API                                       | Its package README and `docs/` folder                                    |
| Rules for changing code                               | [AGENTS.md](AGENTS.md)                                                   |
| Build, check and release scripts                      | [scripts/README.md](scripts/README.md)                                   |
| Terms: coordinator, subagent, worktree, item          | [Glossary](packages/coding-agent/docs/GLOSSARY.md)                       |

## Interface checks

| Interface   | Run (from `packages/coding-agent` unless noted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP         | `yarn workspace @octocodeai/octocode-acp test` (broker, history, input, permissions, startup, redaction); `yarn vitest run --config vitest.e2e.config.ts test/octocode/e2e-acp.test.ts test/octocode/e2e-acp-conformance.test.ts test/octocode/e2e-reach-process.test.ts`; `yarn vitest run --config vitest.config.ts test/acp-api.test.ts test/acp-command-lifecycle.test.ts`; `yarn node test/octocode/scripts/live-acp-reliability.mjs --fixture` (no provider calls). In disposable environments: `test/octocode/scripts/check-acp-compatibility.mjs` (official ACP TCK checkout, `uv`, Python 3.14+; experimental, not certification) and `check-acp-python.mjs` (Python SDK `agent-client-protocol==0.12.1`, both directions) |
| Session API | With an isolated `HOME`, exercise `list` → `status` → guarded `send --wait` → same-key retry → `watch`: a retry starts no second `agent.start`, cancellation shows as a settlement event. Tests: `yarn vitest run --config vitest.octocode.config.ts test/octocode/api-cli-subprocess.test.ts test/octocode/api-socket.test.ts test/octocode/api-events.test.ts`, `test/acp-api.test.ts`, `test/acp-command-lifecycle.test.ts` (`vitest.config.ts`), `test/octocode/e2e-reach-process.test.ts`, `test/octocode/e2e-api-events.test.ts` (`vitest.e2e.config.ts`)                                                                                                                                                                     |
| tmux        | `yarn run test:tmux` (repository root); real-tmux tests use a private server and skip without `tmux` 3.3 or `python3`. `scripts/tmux-cli-check.sh` runs the real CLI in a private server (startup, paste; with `--model` a prompt, `/fork` and image rows; `--cli=<command>` checks another launcher). Image rendering needs a real Kitty or Ghostty window                                                                                                                                                                                                                                                                                                                                                                         |

## Plugin and hook compatibility checks

Normal tests read saved fixtures and need neither Rust nor a vendor binary. Each fixture proves its own narrow contract against source revisions and executables pinned in its manifest, not host equivalence.

| Contract                                                          | Evidence (under `packages/coding-agent/test/`)                                                                                                                                                                                                                                                                                                                                             | Reproduce                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex hook output decisions                                       | `fixtures/hooks/codex-output-contract.json`, read by `hooks-codex-conformance.test.ts`; not exit semantics, timing, permissions or patch rewriting                                                                                                                                                                                                                                         | `node packages/coding-agent/scripts/generate-codex-hook-output-fixtures.mjs [--check]` (Cargo and network)                                                 |
| Codex patch parsing and bytes                                     | [Patch oracle](packages/coding-agent/test/octocode/fixtures/codex-patch/ADAPTATIONS.md)                                                                                                                                                                                                                                                                                                    | Its page                                                                                                                                                   |
| Codex skill metadata                                              | [Metadata oracle](packages/coding-agent/test/fixtures/codex-skill-metadata/ADAPTATIONS.md)                                                                                                                                                                                                                                                                                                 | Its page                                                                                                                                                   |
| Codex skill mentions                                              | [Corpus](packages/coding-agent/test/fixtures/codex-skill-mentions/corpus.json), [manifest](packages/coding-agent/test/fixtures/codex-skill-mentions/manifest.json)                                                                                                                                                                                                                         | `python3 packages/coding-agent/test/fixtures/codex-skill-mentions/replay.py`                                                                               |
| Claude permission decisions, rewrites, file rewrites, replace-all | [replay.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/replay.py), [rewrites.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/rewrites.py), [file-rewrites.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/file-rewrites.py), [replace-all.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/replace-all.py) | Each with `--claude /absolute/path/to/claude --node /absolute/path/to/node`; the recorded version and hash must match, or pass `--allow-identity-mismatch` |
| Claude permission updates                                         | [permission-updates.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/permission-updates.py)                                                                                                                                                                                                                                                                             | The same arguments                                                                                                                                         |
| Claude Bash grammar and wrappers                                  | [grammar.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/grammar.py), [wrappers.py](packages/coding-agent/test/octocode/fixtures/claude-permissions/wrappers.py); narrower than the Bash language, no PowerShell                                                                                                                                                       | The same arguments                                                                                                                                         |

The Claude replays use a local mock provider, temporary settings and a dummy credential, never a live account, and end their process group on a timeout. They use POSIX process handling; Windows is unverified.

## More

[Features and owners](docs/FEATURES.md) · [User docs index](packages/coding-agent/docs/index.md) · [How-to recipes](packages/coding-agent/docs/how-to.md) · [Native features](packages/coding-agent/docs/native-features.md) · [Configuration](packages/coding-agent/docs/configuration.md) · [Prompts](packages/coding-agent/docs/prompts.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE). Independent fork; original Pi copyright notices are retained.
