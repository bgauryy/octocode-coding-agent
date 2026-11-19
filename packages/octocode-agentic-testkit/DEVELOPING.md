# Developing the testkit

Repository-only: this page is not part of the npm package. It covers the parts of the kit that need this
repository (the workspace, `models.json`, the Octocode Agent bundle, the repository's tmp directory).

## Run the suites

Run these in `packages/octocode-agentic-testkit`. From the repository root, `yarn test:agentic` runs `yarn test` here plus the `scripts/agent-eval/` tests; the root `yarn test` leaves both out.

| Goal                                     | Command                                            | Cost                                     |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| every free test                          | `yarn test`                                        | $0, seconds                              |
| harness guards (prompt size, cache, MCP) | `yarn test:guards`                                 | $0                                       |
| types                                    | `yarn typecheck`                                   | $0                                       |
| prompt shape of every agent (bundle)     | `TESTKIT_MEASURE_LABEL=<name> yarn measure`        | $0, ~30 s                                |
| skill triggers on local Ollama           | `yarn test:triggers`                               | $0, ~30 min                              |
| a paid tier                              | `TESTKIT_LIVE=1 yarn tier haiku -- yarn test:live` | paid; cap it with `TESTKIT_TOKEN_BUDGET` |

`yarn tier <name>` copies the tier's credentials from your `models.json` into the child process. It only reads the
file and never prints a key. Paid tests are named `*.live.test.ts`: `yarn test` never collects them, `yarn test:live` runs only them (it sets `OCTOCODE_LIVE_TESTS=1`), and without `TESTKIT_LIVE=1` and a tier they still skip with a reason.

## Package checks

| Goal                                       | Command                                                              | Cost |
| ------------------------------------------ | -------------------------------------------------------------------- | ---- |
| the package as a consumer sees it (linked) | `yarn build && yarn check:consumer`                                  | $0   |
| the packed tarball in a fresh project      | `yarn pack-smoke:testkit --build` (repository root, needs network)   | $0   |
| the real-provider forwarding runs          | `TESTKIT_LIVE=1 yarn test:live test/live/forward-wires.live.test.ts` | paid |

`pack-smoke.mjs` packs the package, installs the tarball and Vitest into a temporary project, takes `vitest.config.ts`
and the quickstart test from the README, and runs them.

## Repository-only pieces

- Workspace install: `"@octocodeai/octocode-agentic-testkit": "workspace:*"` in a workspace `package.json`.
- `yarn tier <name> -- <command>` fills `TESTKIT_<NAME>_*` from `~/.octocode/octocodecode/models.json` (or
  `TESTKIT_MODELS_JSON`); it never prints a key.
- The `octocode-agent` adapter drives this repository's built CLI bundle.
- The repository config sets `TESTKIT_REPORT_DIR` to the repository's `.octocode/tmp`; guards, `yarn measure` and
  `yarn test:triggers` are run-tier tools for this repository's agents.
