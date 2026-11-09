# Working on octocode-code

A coding agent forked from [Pi](https://github.com/earendil-works/pi). `../octocode/packages/octocode-pi-extension` is a migration reference only: never a runtime dependency or a second implementation to update. Terms (coordinator, subagent, worktree, item): [GLOSSARY](packages/coding-agent/docs/GLOSSARY.md).

## Owners

| Path | Owns | Must not |
| --- | --- | --- |
| `coding-agent/src/core/` | sessions, resource loading, prompt assembly; `application/` serves terminal and web | |
| `coding-agent/src/octocode/` | native tools, permissions, subagents, team, memory, hooks, recovery; `index.ts` composes | |
| `coding-agent/src/octocode/instructions/` | agent prose as Markdown (its README maps sections to files) | put prose in `.ts`: `policy.ts`, `lean.ts`, `task.ts` only render |
| `db/src/` | schema, connections, `queries/` (one module per table family), retention; `api.ts` is the only import | |
| `agent/` | agent loop, tool execution, events | hold app configuration or UI policy |
| `ai/` | providers, model data, auth primitives | |
| `tui/` | terminal components, input, rendering | depend on the app |
| `mcp/src/` | the only MCP owner: `client/`, config, registry, lifecycle, exposure; `recommended/` and `presets/browser/` are data | open their own connections |
| `acp/src/` | ACP `server/` and `client/`, host reached through `host.ts` ports | import coding-agent |
| `common/src/` | host-free utilities (JSON, env names, atomic writes, paths, sanitizing, redaction, web guard) | import coding-agent, mcp or acp |
| `contracts/`, `telemetry/` | serializable contracts and schemas | hold DB, provider, DOM or permission code |
| `webview/` | browser state, transport, rendering | execute, authenticate or authorize |

Paths are under `packages/`. Docs: the [docs index](packages/coding-agent/docs/index.md) (configuration: `docs/configuration.md`), package READMEs for public API, `docs/FEATURES.md` for cross-package designs.

## Changing code

- Read the implementation and its callers before changing behavior. Fix a behavior in its owner and a fact in its owning page; reuse existing types, schemas and configuration. Remove a helper or setting only after checking registration, exports, tests and consumers.
- Stay in scope. Keep safety checks, cancellation, session cleanup and public contracts. Preserve user changes (untracked files are not disposable), license notices and historical changelogs.
- **Database:** `prepare(...)`, `db.exec(...)` and `node:sqlite` imports (type imports too) live only in `packages/db/src/`. Search `queries/` before adding a named function; one statement in one place; delete a query with its last caller; features use `type Db`. Enforced by `check:db-boundary` and oxlint (only `team/peer-leases.ts` is exempt).
- **Names:** no `@earendil-works/*`, `@mariozechner/*` or upstream Pi services. New code says Octocode; Pi stays only for compatibility, attribution or history.
- **Instructions:** plain language, condition beside action. Tool descriptions own tool mechanics; policy does not repeat them. No reply template for every task. Machine fields (report outcomes, `to: "parent"`, `parentId`) change only with all their consumers.
- **Configuration:** use the existing path helpers and loaders; keep global/workspace precedence, project trust, and definitions apart from control-only MCP overrides. Update `docs/configuration.md` and the owning reference. Test mutations in isolated user directories, never the real home.
- **Tools and commands:** check registration and RPC consumers separately. Reads use Octocode local tools, mutations `file`; `bash` is the only tool factory. One name per slash command, no aliases, built-ins one word (exception: `/clear` and `/reset` run `/new`). The package root exports only the CLI and RPC. Document tool enablement, MCP exposure and browser routing in [native features](packages/coding-agent/docs/native-features.md).
- **Lint:** files stay within 400 lines (tests exempt): split, never add an exception. `import/no-cycle` counts type-only cycles: move the shared type to a leaf. Silence a rule only on its line with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.

## Verify

Node 24.15+ (Node 24 line); setup and model-data hydration per [DEVELOPMENT.md](DEVELOPMENT.md). Yarn runs everything and owns the only lockfile; npm only packs, publishes or installs as a consumer.

| Command | Does |
| --- | --- |
| `yarn run check` | typecheck, Oxlint, Oxfmt check, boundaries and architecture, DB boundary, bundle freshness, Knip; rewrites nothing |
| `yarn oxfmt <files>` | formats those files; `yarn run format` and an empty list format the whole repo |
| `yarn vitest run --config vitest.octocode.config.ts [paths]` (in `packages/coding-agent`) | native suite; `yarn run test:changed` runs only tests for changed files |
| `yarn workspace @octocodeai/octocodecode run test:e2e` | real sessions on a scripted model, no network; holds the prompt-size ceilings |
| `./test.sh` | every test with isolated config (needs `fd`, `rg`) |
| `yarn run build:offline` | builds every workspace; output in `packages/coding-agent/dist/bundle/` (run `node .../cli.js`); `yarn run build` refreshes model data first; `yarn start` runs source |
| `node scripts/agent-eval/run.mjs --dry-run --model <id>` | plans the ship eval; `--live` runs cost money: only when the user asks ([README](scripts/agent-eval/README.md)) |

- Run builds and full suites in the background; send long output to `.octocode/tmp/` and read it by search or line range. After a wave of changes, run the full e2e: focused runs miss stale expectations elsewhere.
- Report failures and skipped checks. Never weaken assertions or thresholds; change a test only for an intended contract change.
- An MCP tool that refuses twice or disconnects: restart it with `mcp`, then fall back to bash and say so.
- Docs: shipped pages (`packages/coding-agent/docs/`, `docs/`) are for users: explain each feature, Mermaid for flows and tables for options over prose, no repository paths; verify commands and links against their owners; no dated counts in `docs/`. After browser source changes, run `yarn run generate:workspace` and the webview and contracts tests.

## Generated files and releases

Change the generator, never its output (`yarn workspace @octocodeai/octocodecode run <script>`):

- `generate:schemas`, `generate:references`, `generate:casefold`; `generate:vendor` after bumping `marked` or `highlight.js-browser`; `yarn run install-lock:coding-agent`.
- `generate:prompts` (also run by every build) writes each agent's exact prompt to `.octocode/tmp/agent-prompts/`: read it after changing a prompt, tool description or MCP preset.
- After rebuilding the sibling `octocode-mcp` or browser server: `yarn workspace @octocodeai/octocode-mcp run generate:compact` (`--check`, `--drop-stale`, `--accept <tool.field>`), then `generate:prompts`. Overrides never rewrite upstream text to fit a size limit.

`@octocodeai/octocodecode` is the only public package; every other workspace is bundled into it. Its `link:` dependencies and `octocodeRelease` in `packages/coding-agent/package.json` tie it to the sibling `octocode` repository. `yarn run publish` (`publish:dry` rehearses) writes the manifest only into the tarball and publishes after that tarball installs and runs a real session.

## Dogfooding

Research this repository with the Octocode MCP server the session declares. While working, record tool errors, retries, wrong turns and choices that were not the best in `.octocode/REFLECT.md` (its header says how), and fix each cause in its owner or file a backlog item.
