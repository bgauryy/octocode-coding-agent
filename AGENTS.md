# Working on octocode-code

This repository is a coding agent fork of [Pi](https://github.com/earendil-works/pi). The native features were migrated from `../octocode/packages/octocode-pi-extension`; that directory is a reference, not a runtime dependency or a second implementation to update.

## Find the owner

- `packages/coding-agent/src/core/`: sessions, resource loading, SDK and prompt assembly. `core/application/` owns the shared application service and dispatch used by terminal and web adapters.
- `packages/coding-agent/src/octocode/agentdb/`: the only place SQL against the agent database is written. `queries/` holds one module per table family of named functions; `api.ts` is the single API features import from.
- `packages/coding-agent/src/octocode/`: native tools, permissions, subagents, collaboration, memory, hooks and recovery. `index.ts` composes their registration and lifecycle.
- `packages/coding-agent/src/octocode/instructions/`: common policy, bundled roles, child task context and the report contract.
- `packages/agent/`: reusable agent loop, tool execution and events; no application configuration or UI policy.
- `packages/ai/`: provider adapters, model data, authentication primitives and model APIs.
- `packages/tui/`: terminal components, input and rendering; no application dependency.
- `packages/acp/src/`: inbound ACP broker and outbound client in a private workspace compiled into coding-agent. `server/` owns protocol/session translation and `client/` owns peer connections and capture; native execution, permissions, persistence and the local API stay in coding-agent.
- `packages/mcp/src/`: the single MCP owner in a private workspace compiled into coding-agent: protocol client and transports in `client/`, configuration, registry, lifecycle and tool exposure at the root. `presets/octocode/` supplies the default research server and its presentation, and `presets/browser/` the default browser server backed by `@octocodeai/octocode-chrome-devtools`; presets have no separate connection or registry.
- `packages/common/src/`: host-free utilities in a private workspace compiled into coding-agent (mount `common`): JSON and text helpers, environment names, atomic and locked file writes, paths and child processes, terminal-text sanitizing and secret redaction, the web guard, and MCP and browser server names. It imports nothing from coding-agent, mcp or acp; anything needing host configuration stays in the host and reaches shared code through a port.
- `packages/telemetry/`: telemetry contracts and schema utilities; hosts decide collection and export.
- `packages/contracts/`: shared serializable contracts and schemas; no database, provider, DOM or permission implementation.
- `packages/webview/`: browser state, transport and rendering; execution, authentication and authorization remain in the coding-agent host.
- [CONFIGURATIONS.md](CONFIGURATIONS.md): user-facing configuration map. [Documentation index](packages/coding-agent/docs/index.md): package, user and SDK references. Each package README owns its public API guidance; `docs/` holds cross-package designs and reviews.

Use the implementation and its callers to establish behavior before changing it. Keep each behavior in its owning module and each documented fact in its owning page. Prefer existing types, schemas and configuration over parallel definitions. Remove a helper or setting only after checking runtime registration, exports, tests and compatibility consumers.

Preserve existing user changes. This checkout may contain imported, untracked source files; untracked does not mean disposable. Preserve upstream license notices and historical changelogs.

## Implementation and instructions

All agent-database access goes through `octocode/agentdb/api.ts`. Add or change a statement as a named function in the matching `agentdb/queries/` module and call it from features; never write `prepare(...)`, `db.exec(...)` or import `node:sqlite` (type imports too) outside `agentdb/`; features name the handle with `type Db` from `agentdb/api.ts`. Before adding a function, search `queries/` for one that already does the job. Keep one statement in one place and delete a query when its last caller goes. `yarn run check:db-boundary` and an oxlint `no-restricted-imports` rule on `node:sqlite` enforce this (only `team/peer-leases.ts`, which reads another package's database, is exempt).

Keep changes scoped to the requested behavior. Preserve safety checks, cancellation, session cleanup and public contracts when simplifying code. The fork no longer resolves `@earendil-works/*` or `@mariozechner/*` imports; do not reintroduce upstream Pi package names or services.

Write agent instructions in plain language, with conditions beside actions. Tool descriptions own tool mechanics; common policy should not repeat them. Avoid imposing a response template on every task. Preserve machine-consumed report outcomes and protocol fields unless their consumers change together.

When changing configuration discovery or persistence, use the existing path helpers and loaders. Preserve global/workspace precedence, Pi fallback, project trust, and the distinction between definitions and control-only MCP overrides. Update [CONFIGURATIONS.md](CONFIGURATIONS.md) and the owning reference; avoid copying their path tables into package instructions. Validate configuration mutations with isolated user directories rather than changing the developer's real home.

When changing native tools or commands, check registration and SDK consumers separately. Native sessions use Octocode local tools for reads and `file` for mutations; standalone SDK sessions retain Bash factories, while legacy file-tool factories have been removed. Built-in, native and extension slash commands each have exactly one name and no aliases; built-in names are one word, and `registerCommand` refuses an `aliases` option. Keep examples clear about native defaults versus optional extension fixtures. Document tool enablement, MCP exposure and browser-specialist routing in the [native feature guide](packages/coding-agent/docs/native-features.md).

## Verify

Use Node 24.15+ within the Node 24 line for the current sibling dependencies. Follow the root README for installation and model-data hydration. Yarn (the version `packageManager` pins) runs every repository command and owns the only lockfile, `yarn.lock`; npm appears only where the product packs, publishes or installs packages as a consumer would.

- `yarn run check` runs TypeScript, Oxlint, the Oxfmt format check, browser imports, workspace bundle freshness, package-boundary checks and the database boundary without rewriting files.
- `yarn run check:db-boundary` fails when SQL appears outside `octocode/agentdb/`.
- `yarn run check:unused` runs Knip (`knip.jsonc`) for unused files, dependencies, exports and types; runtime-resolved packages and path-invoked entries are listed there with their reason.
- `yarn run lint` runs Oxlint (`.oxlintrc.json`, type-aware through tsgolint on TypeScript 7) over all packages and scripts; `yarn run lint:fix` applies its safe fixes, which still need `tsc` afterwards. `yarn run format` formats code with Oxfmt (`.oxfmtrc.json`, Prettier-compatible).
- Source files stay within 400 lines. The `max-lines` override in `.oxlintrc.json` lists the files that were longer when the rule was adopted; split one and remove it from the list (`scripts/check-max-lines-baseline.mjs` fails while a listed file fits). Never add files to it.
- Use Octocode names in new code; keep Pi references only where they are intentional (compatibility, attribution, history).
- Silence a rule only for a deliberate pattern, on the line, with the reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- `./test.sh` runs all tests with isolated user configuration and credentials. Install `fd` and `ripgrep` for filesystem-tool tests. Bun worker checks run when Bun is available; live provider tests require separate configured runs.
- From `packages/coding-agent`, `yarn vitest run --config vitest.octocode.config.ts` runs the native feature suite; append test paths for a focused run. This config excludes the scripted e2e suites and the Chrome tests. `yarn workspace @octocodeai/octocodecode run test:e2e` (also part of that package's `test`, so `./test.sh` and CI) runs `test/octocode/e2e*.test.ts` with `vitest.e2e.config.ts`: a real session, extension and Octocode MCP server against a scripted model, with no network or credentials; it includes the default prompt-size ceiling.
- `yarn run test:scripts` checks build, packaging and repository scripts.
- `yarn run build:offline` builds using hydrated model data; `yarn start --help` checks the source CLI.

Start a build or full suite in the background and do independent work until its completion message arrives; do not sleep or poll to wait. Redirect a long or unclear command's output to a file under `.octocode/tmp/` and read it by `grep` or line range before diagnosing, never from a truncated tail alone. When an MCP tool keeps refusing its contract after two corrected calls, or reports a lost connection, restart that server with the `mcp` tool; if it still fails, use the bash equivalent and say so.

Run checks relevant to the change and report failures, skipped live checks and missing dependencies accurately. Do not weaken assertions or coverage thresholds to hide failures. Update tests when an intentionally changed contract requires different expectations.

For documentation changes, verify commands, paths and API claims against their owners, check local links and anchors, and retain dated verification results as historical evidence. Do not present old test counts as a new run. When browser source changes, run `yarn run generate:workspace` and the affected webview/contracts tests before checking bundle freshness.

## Generated files and releases

Generate coding-agent schemas with `yarn workspace @octocodeai/octocodecode run generate:schemas`, reference tables with `yarn workspace @octocodeai/octocodecode run generate:references`, the Unicode case-fold table with `yarn workspace @octocodeai/octocodecode run generate:casefold`, and its installer lock with `yarn run install-lock:coding-agent`. Update generators rather than hand-editing their output. Hydrated model data is ignored by Git.

The three local dependencies on the sibling `octocode` repository are currently intentional. Registry publication and portable installer builds require a separate dependency-release change. Keep local validation distinct from registry release validation.
