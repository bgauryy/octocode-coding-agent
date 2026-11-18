# Working on octocode-code

A coding agent forked from [Pi](https://github.com/earendil-works/pi). `../octocode/packages/octocode-pi-extension` is a migration reference only, never a runtime dependency or a second implementation. Terms (coordinator, subagent, worktree, item): [GLOSSARY](packages/coding-agent/docs/GLOSSARY.md).

## Owners

Paths are under `packages/`.

| Path | Owns (✗ must not) |
| --- | --- |
| `coding-agent/src/core/` | sessions, resource loading, prompt assembly; `application/` serves terminal and web; session lines go through `session-manager/codec.ts` |
| `coding-agent/src/octocode/` | native tools, permissions, subagents, team, memory, hooks, recovery; `index.ts` composes (later features via `composedLater`, never reorder); `/web` daemon, `workspace/server.ts` its fallback |
| `coding-agent/src/octocode/native/` | `prompts/` (agent prose as Markdown; README maps sections), `tools/`, `hooks/`, `agents/`, `skills/`; ✗ prose in `.ts` |
| `coding-agent/src/theme/` | theme tokens, shared terminal UI kit; ✗ import `modes/` or `octocode/` |
| `db/src/` | schema, connections, `queries/` (one module per table family), retention; `api.ts` is the only import |
| `agent/` | agent loop, tool execution, events; ✗ app configuration or UI policy |
| `ai/` | providers, model data, auth primitives |
| `tui/` | terminal components, input, rendering, the `@` file index; ✗ depend on the app |
| `mcp/src/` | the only MCP owner: client, config, registry, lifecycle, exposure; `api.ts` is coding-agent's only import; ✗ others open connections |
| `acp/src/` | ACP `server/` and `client/`, host via `host.ts` ports; ✗ import coding-agent |
| `terminal/src/` | `!`-line shell completion, parsing, history ranking; ✗ read settings, history or models (`octocode/terminal/` passes them in) |
| `common/src/` | host-free utilities (JSON, paths, atomic writes, sanitizing, redaction, web guard); ✗ import coding-agent, mcp or acp |
| `contracts/`, `telemetry/` | serializable contracts, schemas and shared guards (`isRecord`); telemetry adds the no-op and a test recorder; ✗ DB, provider, DOM or permission code |
| `webview/` | browser state, transport, rendering; ✗ execute, authenticate or authorize |
| `octocode-agentic-testkit/` | behavior tests for any agent harness through per-harness adapters; ✗ import other workspaces |

Package graph, library vs hosted workspaces, and the path from command to tool call: [DEVELOPMENT.md](DEVELOPMENT.md#packages). Root `scripts/`: build, checks, release, agent eval ([README](scripts/README.md)).

Docs: [index](packages/coding-agent/docs/index.md), [configuration](packages/coding-agent/docs/configuration.md), package READMEs (public API), [FEATURES](docs/FEATURES.md) (cross-package designs).

## Changing code

- Read the implementation and its callers first. Fix behavior in its owner, a fact in its owning page; reuse existing types, schemas and helpers. Remove a helper or setting only after checking registration, exports, tests and consumers.
- Modular code, one owner per unit, so agents work in parallel; clean architecture and code; script repeated steps, printing summaries, not logs.
- Stay in scope. Keep safety checks, cancellation, session cleanup and public contracts. Preserve user changes (untracked files too), license notices and changelogs.
- **Errors:** fail loudly. Catch only the case you expect (a missing file, no credentials) and let the rest propagate or reach a log; never turn damage into an empty result. Every started promise has an owner that awaits or settles it.
- **Database:** `prepare(...)`, `db.exec(...)` and `node:sqlite` imports (type imports too) live only in `packages/db/src/`, enforced by `check:db-boundary` and oxlint (only `team/peer-leases.ts` is exempt). Search `queries/` before adding a function; one statement in one place; delete a query with its last caller; features use `type Db`. In `db/src`, import sibling packages by relative path, never by package name: the writer worker runs on plain Node.
- **Names:** no `@earendil-works/*`, `@mariozechner/*` or upstream Pi services. New code says Octocode; Pi stays only for compatibility, attribution or history.
- **Instructions:** plain language, condition beside action; goals, constraints and decision rules, not mechanical steps or reply templates. Tool descriptions own tool mechanics; policy does not repeat them. Repeatable logic goes in code or a schema. Machine fields (report outcomes, `to: "parent"`, `parentId`) change only with all their consumers.
- **Configuration:** use the existing path helpers and loaders; keep global/workspace precedence, project trust, and definitions apart from control-only MCP overrides. Update `coding-agent/docs/configuration.md`. Test mutations in isolated user directories, never the real home.
- **Tools and commands:** check registration and RPC consumers separately. Reads use Octocode local tools, mutations `file`; `bash` is the only tool factory. Built-ins are one word; Claude Code names map to them in `COMMAND_ALIASES` (`core/slash-commands.ts`), hidden from `/`. The package root exports only the CLI and RPC. Document tool enablement, MCP exposure and browser routing in [native features](packages/coding-agent/docs/native-features.md).
- **Lint:** strict; fix findings. Files stay within 400 lines (tests exempt): split by concern, never add an exception. `import/no-cycle` counts type-only cycles: move the shared type to a leaf. Silence a rule only on its line with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.

## Verify
setup and model-data hydration: [DEVELOPMENT.md](DEVELOPMENT.md). Yarn runs everything and owns the only lockfile; npm only packs, publishes or installs as a consumer.

| Command | Does |
| --- | --- |
| `yarn run check` | typecheck, Oxlint, Oxfmt check, browser smoke, subpaths, bundle and favicon freshness, package/architecture/DB/MCP boundaries, reference pages, Knip; rewrites nothing |
| `yarn oxfmt <files>` | formats those files (`yarn run format`: whole repo) |
| `yarn vitest run --config vitest.octocode.config.ts [paths]` (in `packages/coding-agent`) | native suite (`test/octocode/`); without `--config`, the core suite (the rest of `test/`); `yarn run test:changed` for changed files |
| `yarn workspace @octocodeai/octocodecode run test:e2e` | real sessions on a scripted model, no network; holds the prompt-size ceilings |
| `./test.sh` | every test with isolated config (needs `fd`, `rg`); `yarn test:agentic`: testkit, agent-eval |
| `yarn run build:offline` | builds into `packages/coding-agent/dist/bundle/`; `yarn run build` refreshes model data first; `yarn start` runs source |
| `node scripts/agent-eval/run.mjs --dry-run --model <id>` | plans the ship eval; `--live` costs money: only on request |

- Run builds and full suites in the background, output to `.octocode/tmp/`. After a wave of changes, run the full e2e: focused runs miss stale expectations elsewhere.
- One full suite or `check` at a time on this machine: a host lock makes a second one wait and names the holder. Never bypass it (`OCTOCODE_RUN_LOCK=off`) or run full suites side by side; children run named test files.
- Report failures and skipped checks. Never weaken assertions or thresholds; change a test only for an intended contract change. Test behavior, not instruction wording.
- An MCP tool that refuses twice or disconnects: restart it with `mcp`, then fall back to bash and say so.
- Shipped docs (`packages/coding-agent/docs/`, `docs/`) are for users: Mermaid for flows, tables for options, no repository paths or dated counts; verify commands and links. After browser source changes, run `yarn run generate:workspace` and the webview and contracts tests.

## Generated files and releases

Change the generator, never its output (`yarn workspace @octocodeai/octocodecode run <script>`): `generate:schemas`, `generate:references`, `generate:casefold`, `generate:vendor` (after bumping `marked` or `highlight.js-browser`), `yarn run install-lock:coding-agent`. `generate:prompts` (every build runs it) writes each agent's prompt to `.octocode/tmp/agent-prompts/`: read it after changing a prompt, tool description, MCP preset or the sibling `octocode-mcp`. Octocode ships no overrides: an external MCP server's descriptions, schemas and instructions are never rewritten.

`@octocodeai/octocodecode` and `@octocodeai/octocode-agentic-testkit` are the public packages. Every other workspace is bundled into octocodecode and tied to the sibling `octocode` repository by `link:` dependencies and `octocodeRelease`; the testkit depends on no workspace and publishes on its own (`yarn pack` builds and runs `check:consumer` first). Releases: [DEVELOPMENT.md](DEVELOPMENT.md) (`publish:dry` rehearses).

## Dogfooding

Research with the session's Octocode MCP server. Fix the cause of each tool error, retry or wrong turn you hit in its owner, or file a backlog item with the trigger and evidence. A child puts the trigger and evidence in its report (Noticed) for its coordinator to file.
