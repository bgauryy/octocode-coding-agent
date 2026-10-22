# Working on octocode-code

This repository is a coding agent fork of [Pi](https://github.com/earendil-works/pi). The native features were migrated from `../octocode/packages/octocode-pi-extension`; that directory is a reference, not a runtime dependency or a second implementation to update.

## Find the owner

- `packages/coding-agent/src/core/`: sessions, resource loading, SDK and prompt assembly.
- `packages/coding-agent/src/octocode/`: native tools, permissions, subagents, collaboration, memory, hooks and recovery. `index.ts` composes their registration and lifecycle.
- `packages/coding-agent/src/octocode/instructions/`: common policy, bundled roles, child task context and the report contract.
- `packages/{agent,ai,tui,mcp,codemode,telemetry}/`: supporting runtime libraries.
- `packages/coding-agent/docs/`: user and SDK references. Start at `index.md`.

Use the implementation and its callers to establish behavior before changing it. Keep each behavior in its owning module and each documented fact in its owning page. Prefer existing types, schemas and configuration over parallel definitions. Remove a helper or setting only after checking runtime registration, exports, tests and compatibility consumers.

Preserve existing user changes. This checkout may contain imported, untracked source files; untracked does not mean disposable. Preserve upstream license notices and historical changelogs.

## Implementation and instructions

Keep changes scoped to the requested behavior. Preserve safety checks, cancellation, session cleanup and public contracts when simplifying code. Pi package aliases and configuration fallback are deliberate compatibility paths; see `docs/configuration.md` under the coding-agent package.

Write agent instructions in plain language, with conditions beside actions. Tool descriptions own tool mechanics; common policy should not repeat them. Avoid imposing a response template on every task. Preserve machine-consumed report outcomes and protocol fields unless their consumers change together.

## Verify

Use Node 24.15+ within the Node 24 line for the current sibling dependencies. Follow the root README for installation and model-data hydration.

- `npm run check` runs TypeScript and browser import checks without rewriting files.
- `./test.sh` runs all tests with isolated user configuration and credentials. Install `fd` and `ripgrep` for filesystem-tool tests. Bun worker checks run when Bun is available; live provider tests require separate configured runs.
- From `packages/coding-agent`, `npx vitest run --config vitest.octocode.config.ts` runs the native feature suite; append test paths for a focused run. This config excludes live e2e and Chrome tests.
- `npm run test:scripts` checks build, packaging and repository scripts.
- `npm run build:offline` builds using hydrated model data; `npm start -- --help` checks the source CLI.

Run checks relevant to the change and report failures, skipped live checks and missing dependencies accurately. Do not weaken assertions or coverage thresholds to hide failures. Update tests when an intentionally changed contract requires different expectations.

## Generated files and releases

Generate coding-agent schemas with `npm run generate:schemas --workspace=@octocodeai/octocodecode`, reference tables with `npm run generate:references --workspace=@octocodeai/octocodecode`, and its installer lock with `npm run install-lock:coding-agent`. Update generators rather than hand-editing their output. Hydrated model data is ignored by Git.

The three local dependencies on the sibling `octocode` repository are currently intentional. Registry publication and portable installer builds require a separate dependency-release change. Keep local validation distinct from registry release validation.
