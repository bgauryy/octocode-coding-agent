# Working on octocode-code

This repository is a coding agent fork of [Pi](https://github.com/earendil-works/pi). The native features were migrated from `../octocode/packages/octocode-pi-extension`; that directory is a reference, not a runtime dependency or a second implementation to update.

## Find the owner

- `packages/coding-agent/src/core/`: sessions, resource loading, SDK and prompt assembly. `core/application/` owns the shared application service and dispatch used by terminal and web adapters.
- `packages/coding-agent/src/octocode/`: native tools, permissions, subagents, collaboration, memory, hooks and recovery. `index.ts` composes their registration and lifecycle.
- `packages/coding-agent/src/octocode/instructions/`: common policy, bundled roles, child task context and the report contract.
- `packages/agent/`: reusable agent loop, tool execution and events; no application configuration or UI policy.
- `packages/ai/`: provider adapters, model data, authentication primitives and model APIs.
- `packages/tui/`: terminal components, input and rendering; no application dependency.
- `packages/acp/src/`: inbound ACP broker and outbound client in a private workspace compiled into coding-agent. `server/` owns protocol/session translation and `client/` owns peer connections and capture; native execution, permissions, persistence and the local API stay in coding-agent.
- `packages/mcp/src/`: the single MCP owner in a private workspace compiled into coding-agent: protocol client and transports in `client/`, configuration, registry, lifecycle and tool exposure at the root. `presets/octocode/` supplies the default research server and its presentation, and `presets/browser/` the default browser server backed by `@octocodeai/octocode-chrome-devtools`; presets have no separate connection or registry.
- `packages/telemetry/`: telemetry contracts and schema utilities; hosts decide collection and export.
- `packages/contacts/`: shared serializable contracts and schemas; no database, provider, DOM or permission implementation.
- `packages/webview/`: browser state, transport and rendering; execution, authentication and authorization remain in the coding-agent host.
- [CONFIGURATIONS.md](CONFIGURATIONS.md): user-facing configuration map. [Documentation index](packages/coding-agent/docs/index.md): package, user and SDK references. Each package README owns its public API guidance; `docs/` holds cross-package designs and reviews.

Use the implementation and its callers to establish behavior before changing it. Keep each behavior in its owning module and each documented fact in its owning page. Prefer existing types, schemas and configuration over parallel definitions. Remove a helper or setting only after checking runtime registration, exports, tests and compatibility consumers.

Preserve existing user changes. This checkout may contain imported, untracked source files; untracked does not mean disposable. Preserve upstream license notices and historical changelogs.

## Implementation and instructions

Keep changes scoped to the requested behavior. Preserve safety checks, cancellation, session cleanup and public contracts when simplifying code. The fork no longer resolves `@earendil-works/*` or `@mariozechner/*` imports; do not reintroduce upstream Pi package names or services.

Write agent instructions in plain language, with conditions beside actions. Tool descriptions own tool mechanics; common policy should not repeat them. Avoid imposing a response template on every task. Preserve machine-consumed report outcomes and protocol fields unless their consumers change together.

When changing configuration discovery or persistence, use the existing path helpers and loaders. Preserve global/workspace precedence, Pi fallback, project trust, and the distinction between definitions and control-only MCP overrides. Update [CONFIGURATIONS.md](CONFIGURATIONS.md) and the owning reference; avoid copying their path tables into package instructions. Validate configuration mutations with isolated user directories rather than changing the developer's real home.

When changing native tools or commands, check registration and SDK consumers separately. Native sessions use Octocode local tools for reads and `file` for mutations; standalone SDK sessions retain Bash factories, while legacy file-tool factories have been removed. Canonical built-in slash commands use one word. Documented compatibility aliases may contain hyphens; resolve them through shared command metadata and preserve the canonical handler, authorization and lifecycle. Keep examples clear about native defaults versus optional extension fixtures. Document tool enablement, MCP exposure and browser-specialist routing in the [native feature guide](packages/coding-agent/docs/native-features.md).

## Verify

Use Node 24.15+ within the Node 24 line for the current sibling dependencies. Follow the root README for installation and model-data hydration. Yarn (the version `packageManager` pins) runs every repository command and owns the only lockfile, `yarn.lock`; npm appears only where the product packs, publishes or installs packages as a consumer would.

- `yarn run check` runs TypeScript, Oxlint, the Oxfmt format check, browser imports, workspace bundle freshness and package-boundary checks without rewriting files.
- `yarn run lint` runs Oxlint (`.oxlintrc.json`, type-aware through tsgolint on TypeScript 7) over all packages and scripts; `yarn run lint:fix` applies its safe fixes, which still need `tsc` afterwards. `yarn run format` formats code with Oxfmt (`.oxfmtrc.json`, Prettier-compatible).
- Source files stay within 400 lines. The `max-lines` override in `.oxlintrc.json` lists the files that were longer when the rule was adopted; split one and remove it from the list (`scripts/check-max-lines-baseline.mjs` fails while a listed file fits). Never add files to it.
- Silence a rule only for a deliberate pattern, on the line, with the reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- `./test.sh` runs all tests with isolated user configuration and credentials. Install `fd` and `ripgrep` for filesystem-tool tests. Bun worker checks run when Bun is available; live provider tests require separate configured runs.
- From `packages/coding-agent`, `yarn vitest run --config vitest.octocode.config.ts` runs the native feature suite; append test paths for a focused run. This config excludes live e2e and Chrome tests.
- `yarn run test:scripts` checks build, packaging and repository scripts.
- `yarn run build:offline` builds using hydrated model data; `yarn start --help` checks the source CLI.

Run checks relevant to the change and report failures, skipped live checks and missing dependencies accurately. Do not weaken assertions or coverage thresholds to hide failures. Update tests when an intentionally changed contract requires different expectations.

For documentation changes, verify commands, paths and API claims against their owners, check local links and anchors, and retain dated verification results as historical evidence. Do not present old test counts as a new run. When browser source changes, run `yarn run generate:workspace` and the affected webview/contracts tests before checking bundle freshness.

## Generated files and releases

Generate coding-agent schemas with `yarn workspace @octocodeai/octocodecode run generate:schemas`, reference tables with `yarn workspace @octocodeai/octocodecode run generate:references`, and its installer lock with `yarn run install-lock:coding-agent`. Update generators rather than hand-editing their output. Hydrated model data is ignored by Git.

The three local dependencies on the sibling `octocode` repository are currently intentional. Registry publication and portable installer builds require a separate dependency-release change. Keep local validation distinct from registry release validation.
