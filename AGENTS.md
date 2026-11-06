# Working on octocode-code

A coding agent forked from [Pi](https://github.com/earendil-works/pi). `../octocode/packages/octocode-pi-extension` is the migration source: a reference, never a runtime dependency or a second implementation to update.

## Owners

- `packages/coding-agent/src/core/`: sessions, resource loading, prompt assembly; `core/application/` owns the application service and dispatch shared by terminal and web.
- `packages/coding-agent/src/octocode/`: native tools, permissions, subagents, collaboration, memory, hooks, recovery; `index.ts` composes them.
- `packages/coding-agent/src/octocode/instructions/`: policy, roles, child task context, report contract. The prose is Markdown (`policy/`, `lean/`, `subagent/`, `system/`, `workflows/`, `roles/`; its README maps sections to files). `policy.ts`, `lean.ts` and `task.ts` only derive flags and render through `core/prompt-template.ts`. Edit the Markdown.
- `packages/db/src/`: agent database schema, connections, queries (`queries/`, one module per table family) and retention; `api.ts` is the only API features import.
- `packages/agent/`: agent loop, tool execution, events; no app configuration or UI policy.
- `packages/ai/`: providers, model data, authentication primitives, model APIs.
- `packages/tui/`: terminal components, input, rendering; no app dependency.
- `packages/mcp/src/`: the only MCP owner. `client/` holds protocol and transports; the root holds configuration, registry, lifecycle and exposure. `presets/octocode/` (research server) and `presets/browser/` (`@octocodeai/octocode-chrome-devtools`) have no connection or registry of their own.
- `packages/acp/src/`: ACP broker (`server/`) and client (`client/`). It imports nothing from coding-agent and reaches the host only through `AcpServerHost`/`AcpClientHost` (`host.ts`), installed by `main/acp-host.ts` and `octocode/external/acp-host.ts`. Execution, permissions, persistence and the local API stay in coding-agent.
- `packages/common/src/` (mount `common`): host-free utilities (JSON and text, environment names, atomic and locked writes, paths, child processes, terminal sanitizing, secret redaction, the web guard, MCP and browser server names). It imports nothing from coding-agent, mcp or acp; host configuration reaches it through a port.
- `packages/telemetry/`: contracts and schema utilities; hosts decide collection and export.
- `packages/contracts/`: serializable contracts and schemas; no database, provider, DOM or permission code.
- `packages/webview/`: browser state, transport, rendering; execution, authentication and authorization stay in the host.
- Docs: [CONFIGURATIONS.md](CONFIGURATIONS.md) (configuration map), [documentation index](packages/coding-agent/docs/index.md), package READMEs (public API), `docs/` (cross-package designs, indexed by `docs/FEATURES.md`).

## Changing code

- Establish behavior from the implementation and its callers first. Keep each behavior in its owning module and each fact in its owning page; reuse existing types, schemas and configuration. Remove a helper or setting only after checking registration, exports, tests and compatibility consumers.
- Scope changes to the request; keep safety checks, cancellation, session cleanup and public contracts. Preserve user changes (untracked files are not disposable), upstream license notices and historical changelogs.
- Database: only `packages/db/src/` may call `prepare(...)` or `db.exec(...)` or import `node:sqlite` (type imports too). Add a statement as a named function in the matching `queries/` module, after searching for one that already does the job. Keep one statement in one place and delete a query with its last caller. Features use `type Db` from `api.ts`. `yarn run check:db-boundary` and oxlint `no-restricted-imports` enforce this; only `team/peer-leases.ts` is exempt.
- Never reintroduce `@earendil-works/*` or `@mariozechner/*` imports or upstream Pi package names and services. New code uses Octocode names; Pi references stay only for compatibility, attribution or history.
- Agent instructions: plain language, with the condition beside the action. Tool descriptions own tool mechanics, and policy does not repeat them. No response template for every task. Keep machine-consumed report outcomes and protocol fields unless their consumers change together.
- Configuration discovery or persistence: use the existing path helpers and loaders. Keep global/workspace precedence, Pi fallback, project trust, and the split between definitions and control-only MCP overrides. Update CONFIGURATIONS.md and the owning reference without copying their path tables. Test mutations with isolated user directories, never the real home.
- Native tools and commands: check registration and RPC consumers separately. Reads use Octocode local tools and mutations use `file`; `bash` is the only kept tool factory. Each slash command has one name and no aliases (built-in names are one word); the exception, at the user's request, is `/clear` and `/reset`, which run the `/new` handler. The package root exports only the CLI and RPC (`RpcClient`, `runRpcMode`, `runPrintMode`); `src/extension-host-api.ts` goes away with the extension loader. Document tool enablement, MCP exposure and browser routing in [native features](packages/coding-agent/docs/native-features.md).
- Lint:
  - Source files stay within 400 lines (`max-lines`; tests are exempt; `yarn run check` notes files from 350 lines). Split the file rather than adding an exception.
  - `import/no-cycle` also counts type-only cycles. Move the shared type to a leaf module.
  - Silence a rule only on the line, with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.

## Dogfooding

While you work, record in `.octocode/REFLECT.md` where Octocode itself got in the way: tool errors, refused or retried calls, wrong turns, and choices that worked but were not the best. The file is local; create it if it is missing. For each entry, trace the cause to the product (a tool, its description, a prompt, a permission). Then fix it in its owning module, or file a backlog item. Lessons stay in that file, not here.

## Verify

Use Node 24.15+ on the Node 24 line, and install and hydrate model data per the root README. Yarn (pinned by `packageManager`) runs every command and owns the only lockfile, `yarn.lock`; npm appears only where the product packs, publishes or installs as a consumer.

| Command                                                                                 | Does                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn run check`                                                                        | TypeScript, Oxlint, Oxfmt, browser imports, bundle freshness, package boundaries with `test:architecture`, the database boundary and Knip, in parallel (`scripts/run-checks.mjs`); rewrites nothing                                                                                                                                            |
| `yarn run lint`, `lint:fix`, `format`                                                   | Oxlint (`.oxlintrc.json`, type-aware); its safe fixes (run `tsc` after); Oxfmt (`.oxfmtrc.json`)                                                                                                                                                                                                                                               |
| `yarn run check:unused`                                                                 | Knip; `knip.jsonc` lists runtime-resolved entries with their reason                                                                                                                                                                                                                                                                            |
| `./test.sh`                                                                             | all tests with isolated configuration and credentials; needs `fd` and `ripgrep`, runs Bun checks when Bun exists; live provider tests need separate configured runs                                                                                                                                                                            |
| `yarn vitest run --config vitest.octocode.config.ts [paths]` in `packages/coding-agent` | native feature suite, without the e2e and Chrome tests                                                                                                                                                                                                                                                                                         |
| `yarn workspace @octocodeai/octocodecode run test:e2e`                                  | `test/octocode/e2e*.test.ts`: a real session and MCP server with a scripted model and no network; holds the prompt-size ceiling                                                                                                                                                                                                                |
| `yarn workspace @octocodeai/octocodecode run test:coverage`                             | native suite with its coverage thresholds                                                                                                                                                                                                                                                                                                      |
| `yarn run test:scripts`                                                                 | build, packaging and repository scripts                                                                                                                                                                                                                                                                                                        |
| `yarn run build:offline`                                                                | every workspace with hydrated model data (`yarn run build` regenerates it first); coding-agent bundles into `dist/bundle/octocode.js` (`scripts/build-coding-agent.mjs`). `yarn start --help` checks the source CLI                                                                                                                            |
| `node scripts/agent-eval/run.mjs --dry-run --model <provider/id>`                       | plans the ship gate: baseline build against candidate build, correctness no worse, then cost per task lower. `--live --max-usd <n>` and `understand.mjs --live --max-usd <n> --provider <name>` (a small model grading how each agent's prompt would act) spend money: agree them with the user first ([README](scripts/agent-eval/README.md)) |

- Run builds and full suites in the background, without sleeping or polling. Send long output to `.octocode/tmp/` and read it by `grep` or line range, never from a truncated tail.
- If an MCP tool keeps refusing its contract after two corrected calls, or loses its connection, restart it with `mcp`; if it still fails, use bash and say so.
- Report failures, skipped live checks and missing dependencies. Never weaken assertions or coverage thresholds; change a test only for an intended contract change.
- Docs: verify commands, paths and API claims against their owners, and check links and anchors. Keep dated results and counts out of `docs/`, and never present old counts as a new run. After a browser source change, run `yarn run generate:workspace` and the affected webview and contracts tests before checking bundle freshness.

## Generated files and releases

Change the generator, never its output. Scripts below run with `yarn workspace @octocodeai/octocodecode run <script>` unless shown otherwise.

- **Coding-agent generators:**
  - `generate:schemas`, `generate:references` and `generate:casefold`;
  - `generate:vendor` after changing `marked` or `highlight.js-browser`. It writes the committed `src/core/export-html/vendor/`;
  - `yarn run install-lock:coding-agent` for the installer lock.
- **Agent prompts:** `generate:prompts`, which every `build:offline` also runs, writes each agent's exact prompt to `.octocode/tmp/agent-prompts/`. Read it after changing a prompt source, tool description or MCP preset.
- **MCP overrides and fixtures:** after the sibling `octocode-mcp` or the browser server is rebuilt, run `yarn workspace @octocodeai/octocode-mcp run generate:compact`, then `generate:prompts`.
  - It refreshes `packages/mcp/src/presets/*/compact-overrides.json` and `packages/mcp/test/fixtures/compact/`, and lists overrides whose upstream text changed.
  - Options: `--drop-stale` deletes them; `--accept <tool.field>` or `--accept-all` keeps those still true; `--check` changes nothing.
  - Overrides are optional and never rewrite upstream text to fit a size limit.
- Git ignores hydrated model data.

`@octocodeai/octocodecode` is the only public package; every other workspace is private and bundled into it. Three pointers tie it to the sibling `octocode` repository:

- its three `link:` dependencies, which are intentional;
- `.github/octocode-ref`, the sibling ref this code needs (CI and the README read it);
- `octocodeRelease` in `packages/coding-agent/package.json`, the exact npm versions a release uses.

`yarn run publish` (`scripts/publish.mjs`; `publish:dry` rehearses it) writes the published manifest only into the tarball. It publishes only after that tarball installs from npm and runs a real session. Keep local validation distinct from registry release validation.
