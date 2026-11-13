# Octocode comprehensive audit

Review date: 13 November 2026, Asia/Jerusalem. Execution timestamps in the evidence files are UTC.

## Remediation update

**The reproduced implementation defects have been corrected and their focused regressions pass. Release clearance remains blocked by the verification environment and concurrent changes outside the remediation lanes.** The original audit below is historical evidence; its open-finding descriptions are superseded by this update.

| Finding | Current disposition | Implementation / evidence |
| --- | --- | --- |
| A01–A03: pending work identities | Retained the identity ledger, corrected additional deadline ownership, and fixed real RPC result handling | [pending waits](packages/coding-agent/src/octocode/subagents/pending-waits.ts), [deadlines](packages/coding-agent/src/octocode/subagents/event-deadlines.ts); [final RPC regressions](.octocode/tmp/audit-fixes/rpc-wire-after.log): 63 passed |
| A04: API security default | Corrected | [SECURITY.md](SECURITY.md) now states default Unix socket, opt-in HTTP, global disable and Windows activation; [existing default contract](.octocode/tmp/audit-fixes/api-default.log) passes |
| A05: fresh-home Yarn bootstrap | Corrected | The isolated launcher uses the checked-in Yarn through the existing command helper. The real full run reached test execution without a Corepack download |
| A06: omitted later suites | Corrected | Core/native/e2e and workspaces continue after ordinary failure; signals stop subsequent admission and supervise owned POSIX descendants. [Runner tests](.octocode/tmp/audit-fixes/test-infrastructure-focused.log): 10 passed |
| A07: reference drift | Current generated pages verified | [Reference and footer check](.octocode/tmp/audit-fixes/wsl-poll-after.log): 10 passed, including all four generated reference pages |
| A08: moving source / unsupported environment | Still a release-verification blocker | Starting diffs, source hashes and command logs retained in [audit-fixes](.octocode/tmp/audit-fixes/). New unrelated source changes appeared during several static runs |
| A09: deadline fixture | Corrected without weakening assertions | Fixture now models matching job/log identity. Five additional deadline regressions were reproduced and fixed before the final real-RPC run |
| A10: stale lint suppression | Remains corrected | No suppression or threshold was added to permit these fixes |

### Additional confirmed defects and root causes

| Defect | Root cause and change | Regression evidence |
| --- | --- | --- |
| Real timer/reply operations did not settle | Actual agent-loop tool-end events omit `args`; earlier tests fabricated them. The reducer now correlates timer/reply/cancel inputs with their start call and discards that input after its result. Public RPC events are unchanged | Removing the fabricated arguments first produced three failures; the corrected suite and dependent reducer tests pass. Failed timer/reply calls are also covered |
| Job deadlines survived completion or were borrowed from another call | A global maximum outlived the job that owned it. Deadlines now follow each outstanding job/tool call, including the original foreground deadline at background handoff | [Before](.octocode/tmp/audit-fixes/pending-work-regressions-before.log); [after](.octocode/tmp/audit-fixes/rpc-wire-after.log) |
| Cancellation admitted work or revived disposed contexts | Cancellation could occur at final handoff, before listener attachment, or after a reservation wait resolved. Late completions also reached an old context, while lease release lost its original store | [Process supervision](packages/coding-agent/src/octocode/subagents/process/supervise.ts), [reservation](packages/coding-agent/src/octocode/subagents/reservation.ts), [spawn](packages/coding-agent/src/octocode/subagents/spawn.ts), [child finalization](packages/coding-agent/src/octocode/subagents/child-tasks.ts), [leases](packages/coding-agent/src/octocode/team/session/child-leases.ts); [15 deterministic tests pass](.octocode/tmp/audit-fixes/cancellation/shutdown-after.log) |
| Footer missed branch changes during watcher recovery | Re-arming a native watcher does not replay changes made while detached. The existing retry callback now refreshes the branch, including repeated native failures | Two failing counterexamples now pass |
| WSL reftable branch changes remained invisible | The fallback polled HEAD alone although reftable branch changes can leave it unchanged. WSL now also polls `tables.list`, with per-instance listener cleanup | Unchanged-HEAD/native-silence regression and disposal assertions pass in [footer verification](.octocode/tmp/audit-fixes/wsl-poll-after.log) |
| Repeated failed terminal initialization leaked listeners in an earlier execution path | The current staged startup rollback already removes the stream/process handlers; retained and verified that correction rather than raising listener limits | [19 focused tests](.octocode/tmp/audit-fixes/listener-lifecycle-focused.log); [20-cycle probe](.octocode/tmp/audit-fixes/listener-ownership-probe.log): zero retained listeners with rollback, 20 per stream when rollback is bypassed |

### Verification ledger

Runs overlap and must not be added into a distinct-test total. All executions used Node 26.4.0, not the required Node 24 line.

| Gate | Observed result |
| --- | --- |
| Initial whole static gate | 11/11 passed; [log](.octocode/tmp/audit-fixes/check-initial.log) |
| Latest completed whole static gate | **7/11 passed; four failed:** lint, format, workspace freshness and architecture boundaries. [check-current.log](.octocode/tmp/audit-fixes/check-current.log); preceding failures from changing source are preserved separately. This is not a green final gate |
| Final focused wait/deadline/RPC tests | 63 passed across three files; exit 0 |
| Timer owner tests | 61 passed; [log](.octocode/tmp/audit-fixes/pending-work-timers.log) |
| Admission, shutdown and late completion | 15 passed, using gates and fake timers; real OS process cleanup remains unverified |
| Footer recovery, WSL and generated references | 10 passed; exit 0 |
| Runner failure/cancellation regressions | 10 passed; no skipped tests |
| Scoped coordinator lint and whitespace | Exit 0 |
| Offline build and bundled CLI | [Final build](.octocode/tmp/audit-fixes/build-final.log) passed; bundled `--version` and `--help` exited 0 |
| ACP / agent / DB / contracts / telemetry / terminal | 185 / 172 / 62 / 113 / 27 / 47 passed in their complete package runs |
| Webview | 629 passed, one navigation timeout in the broad run; that same test passes unchanged in a one-worker recheck |
| TUI performance focus | All nine tests pass unchanged in isolation. Full TUI run still fails tmux socket prerequisites and one block-math CPU budget under load; no performance threshold was changed |
| Full e2e | 244 passed, eight failed, 145 skipped; 29 failed files include unavailable suite setup. [Log](.octocode/tmp/audit-fixes/e2e.log) |
| Claude Code e2e failure investigation | Each of the three affected cases records `Claude Code failed: listen EPERM ... 127.0.0.1`. Its tool bridge binds before the fixture peer starts, explaining the missing journal and timeout. No provider/authentication defect was confirmed; [diagnostics](.octocode/tmp/audit-fixes/claude-code-diagnostic.log) |
| Whole isolated repository run | Scripts: 219 passed, three socket failures; ACP and agent passed; AI: 3,681 passed, 45 failed, 863 skipped, 18 unhandled errors. Curtailed during core after recurring unavailable prerequisites; root exit 130. Later package stages are not presumed executed |
| Independent native run | Attempted and curtailed after socket failures; exit 130, no final counts or pass verdict |
| Consumer installation | Retried with isolated npm home/cache/configuration; blocked by `registry.npmjs.org` DNS for a production dependency. No consumer-install pass is claimed |
| Full production dependency audit | Blocked by the same registry DNS failure; no clean advisory verdict |

### Remaining acceptance work and confidence

Confidence is high in the reproduced counterexamples and focused fixes. A complete release verdict still requires a stable source checkpoint on Node 24 with working loopback/Unix sockets, native watchers and process inspection. This host reports TCP/Unix `EPERM`, asynchronous native-watch `EMFILE`, and registry `ENOTFOUND`. The ordinary polling fallback was observed working; the native-watch-only assertions cannot pass here.

The closure checkpoints differ in **41 source paths**, including configuration, provider selection, terminal UI and webview changes outside the assigned remediation lanes: [source-drift.json](.octocode/tmp/audit-fixes/source-drift.json). The latest gate observed React lint failures in `board-flow.tsx` and its test, unobserved settings-save promises, a formatting difference, stale generated workspace assets, and an interactive-host usage count of 2,203 against the existing 2,200 ceiling. The ceiling and assertions were retained. Workspace assets were regenerated after that run; the other moving inputs require review and a fresh complete gate on a stable tree. These are explicit remaining verification/integration issues, not presumed fixed by the focused audit patches.

Run `yarn run check`, `./test.sh`, the complete e2e stage, `yarn run build:offline`, `yarn run check:package-install`, and `yarn audit` on that supported host. Retain skipped/live-provider, Windows/native-target, physical terminal/browser, real process-tree cleanup, crash/power-loss and representative performance checks as explicit gaps until executed. No publishing, paid inference, live credentials or real-home configuration changes were performed.

### Research and execution ownership

The coordinator owned integration, footer/RPC corrections, checkpoints and reporting. Separate agents owned test infrastructure, pending-work/deadline corrections, lifecycle cancellation, and independent adversarial review. Conflicting writes were serialized; all agents are now closed. Existing user changes were preserved, including staged work. Full-run results from a changing tree are diagnostic evidence, not proof of every feature.

Primary references consulted: [Yarn `yarnPath`](https://yarnpkg.com/configuration/yarnrc#yarnPath), [Yarn Corepack](https://yarnpkg.com/corepack), and [Node 24 filesystem watcher availability](https://nodejs.org/docs/latest-v24.x/api/fs.html#availability). The checked-out implementations and actual emitter/consumer paths determine applicability.

## Original audit evidence

The remaining sections preserve the original audit and its historical execution results.

## Executive summary

**Release clearance is not established.** The audit initially reproduced three pending-work accounting defects. Concurrent work then added identity-aware settlement: all eight audit probes now pass against the updated source. RPC reference-generator drift was also corrected concurrently; the latest comparison matches all four generated pages. Those findings must not be presented as still open. The security overview still misstates the local API default, and one legacy deadline test fails. Broad test execution encounters forbidden sockets/process inspection, uses Node 26 rather than the mandated Node 24 line, and spans substantial concurrent source changes.

This audit inventories all 12 workspaces and all 45 native feature directories against the [feature index](docs/FEATURES.md) and [documentation index](packages/coding-agent/docs/index.md). It combines repository-wide checks, broad suite execution, targeted source tracing, counterexamples and dependency checks. An inventoried feature or passing package suite is not proof that every behavior, platform or failure interleaving was verified.

**Confidence:** high in the initial accounting failures, their passing counterexamples after the concurrent fix, the API documentation mismatch and recorded command outcomes; medium in broader architectural assurance; unresolved for live hangs, production recovery, external providers and environments that could not run here.

No implementation or test file was changed by this audit. Reports, reproduction drivers and the dogfooding log are the audit's own writes. Concurrent work changed implementation, tests and instructions during execution; the source comparisons record that separately. Broad results are diagnostic mixed-revision evidence, not certification of the latest tree.

## Key findings

| ID | Priority | Finding | Evidence and consequence | Confidence |
| --- | --- | --- | --- | --- |
| A01 | Initially P0; focused verification now passes | Unrelated notices consumed reply waits in the initial checkpoint | The initial helper decremented a shared count without matching identity, including through the real reducer. Concurrent changes now match work kind/ID and derive the count; all four affected probes pass. | High; before/after execution |
| A02 | Initially P1; focused verification now passes | Active repeating wakes lost their pending count in the initial checkpoint | Initially the count became 0 after an active wake. The updated ledger retains active timers; the same invariant now passes. | High; before/after execution |
| A03 | Initially P1; focused verification now passes | Successful cancellation left a stale pending count in the initial checkpoint | Initially one cancelled timer left `waits: 1`. The updated successful-cancel path removes the matching timer; the same invariant now passes. | High; before/after execution |
| A04 | P1 | Security overview incorrectly calls the local session API opt-in | [SECURITY.md](SECURITY.md):13 conflicts with `getSessionApi()` at `environment.ts:91`, startup transport selection and [session-api.md](packages/coding-agent/docs/session-api.md):41. Unix sockets default on; HTTP is opt-in; Windows differs. | High; source and existing oracle |
| A05 | P2 | The isolated test launcher depends on an externally bootstrapped Yarn | The direct `./test.sh` attempt fails before running tests: the fresh HOME makes Corepack request `repo.yarnpkg.com`, which cannot resolve. A temporary shim invoking the checked-in Yarn permits execution. | High; observed on this host |
| A06 | P1 | One failing coding-agent suite prevents later feature suites from running | `packages/coding-agent/package.json:51` chains core, native and e2e with `&&`. The root runner continues across workspaces, but cannot recover these omitted stages. Independent native/e2e runs were therefore scheduled for this audit. | High; source |
| A07 | Observed P1; latest comparison passes | RPC reference-generator drift was found and corrected concurrently | The broad run failed `references.test.ts:19`; the generator omitted implemented lean block-end behavior. At the final comparison all four pages match their renderer. | High; before/after execution |
| A08 | P0 verification blocker | The source changed substantially during broad execution | The before/after file maps differ across agent-loop, wait accounting, DB, terminal/UI and instruction owners. Suite totals cannot be combined into a stable latest-revision verdict. | High; file hashes |
| A09 | P1 validation failure | An older reducer deadline fixture has not been aligned with identity-aware completion | Focused run: 57 pass, 1 fail. `subagent-events.test.ts:498` returns no job ID and `:502` supplies no notice identity, then `:505` expects the deadline cleared. All 10 new pending-work tests pass. | High in failure/fixture facts; medium that fixture alignment alone closes it |
| A10 | Observed P1; concurrent correction passes targeted lint | An intermediate static run failed on an unused suppression | The unused directive in `command-dispatch.ts` was removed concurrently; the exact file now passes Oxlint. The final whole static run is recorded below. | High; before/after execution |

P0 denotes a release-sign-off requirement, not a claim of demonstrated data loss or a security exploit. A01–A03 share the existing B72 owner and have been addressed by concurrent work for the scenarios exercised here. Their initial observed effect was accounting/report classification; causation of a historical live hang remains unproven. Complete lifecycle/race sign-off still requires the remaining matrix and a stable supported-runtime run.

### Reproduction and counterexamples

Run from the repository root:

```sh
node --import ./packages/coding-agent/scripts/source-resolver.ts \
  .octocode/tmp/audit-2026-11-13/wait-repro-current.ts
```

The current driver exits 0: all eight invariants/controls pass. The original driver and output preserve the initial six failures. The current driver adds the new `workWaits` state field required by the changed interface; it otherwise repeats the same events and expectations. Both import the implementation rather than duplicating it or altering tests.

| Invariant | Expected | Initial actual | Updated actual |
| --- | --- | --- | --- |
| Active repeating timer stays pending after its first wake | 1 wait | 0 | 1 |
| Successful cancellation removes that timer's wait | 0 waits | 1 | 0 |
| Unrelated job notice preserves an outstanding reply | 1 wait | 0; reply record remains | 1 |
| Unrelated timer notice preserves an outstanding reply | 1 wait | 0; reply record remains | 1 |
| Real reducer retains waiting after unrelated job notice | `waiting: true` | `false` | `true` |
| Real reducer retains waiting after unrelated timer notice | `waiting: true` | `false` | `true` |
| Control: unrelated team message preserves the reply wait | 1 wait | 1 | 1 |
| Control: matching team reply settles its wait | 0 waits | 0 | 0 |

Evidence: [initial driver](.octocode/tmp/audit-2026-11-13/wait-repro.ts), [initial observations](.octocode/tmp/audit-2026-11-13/wait-repro.json), [updated driver](.octocode/tmp/audit-2026-11-13/wait-repro-current.ts), [updated observations](.octocode/tmp/audit-2026-11-13/wait-repro-current.json). The [initial pending-waits source](.octocode/tmp/audit-2026-11-13/initial/pending-waits.ts) and [initial reducer](.octocode/tmp/audit-2026-11-13/initial/events.ts) were recovered from the base commit and verified byte-for-byte against the initial hashes. Current owners: [pending-waits.ts](packages/coding-agent/src/octocode/subagents/pending-waits.ts), [events.ts](packages/coding-agent/src/octocode/subagents/events.ts), [timer tool](packages/coding-agent/src/octocode/timer/tool.ts).

The strongest rival explanation is that the runtime's independent timer/job hold already protects completion. That protection exists: `TimerScheduler.settle()` tracks held timer IDs (`scheduler.ts:105`), and `fire()` suppresses cancelled or stopped wakes (`scheduler.ts:259`). It does not repair the separately reproduced parent-side accounting. Consequently, this audit does not infer that every counter error terminates or hangs the child process.

## Analysis

### Verification and reproducibility

Base commit: `f473b1aa7f423ac3b052bf9cfc7f2459eea7a01a`, with the user's dirty implementation preserved. The initial snapshot hashes 5,849 tracked/untracked files outside audit outputs. Its file-map fingerprint is `4586e08ab387613059d122c6c1e4ee5b933a90bc430097dfdecd5c3e2d74ebde`. This is the audit's own file-map algorithm; it is not interchangeable with the existing test plan's diff digest.

The active runtime is Node `v26.4.0`, Yarn `4.18.1`. The project mandates Node 24.15+ within Node 24 ([DEVELOPMENT.md](DEVELOPMENT.md):9). Socket creation returns EPERM for TCP loopback and Unix sockets; `ps` is forbidden. No real-home configuration, live databases, credentials, external agents or paid inference were exercised.

| Gate | Result | Evidence |
| --- | --- | --- |
| First static run | 10/11 passed; one type-import lint error | [check.log](.octocode/tmp/audit-2026-11-13/check.log) |
| Second static run | **11/11 passed** after the import correction, before the later broad source changes | [check-final.log](.octocode/tmp/audit-2026-11-13/check-final.log) |
| Intermediate later static run | **10/11 passed; lint failed**, A10 subsequently corrected | [check-current.log](.octocode/tmp/audit-2026-11-13/check-current.log) |
| Final static run | **11/11 passed** | [check-latest.log](.octocode/tmp/audit-2026-11-13/check-latest.log) |
| Model-data prerequisite | Passed | [model-data.log](.octocode/tmp/audit-2026-11-13/model-data.log) |
| Direct isolated launcher | Blocked before tests: Corepack DNS | [tests.log](.octocode/tmp/audit-2026-11-13/tests.log) |
| Whole repository with pinned Yarn | Interrupted during MCP; subsequent package owners checked separately | [test output](.octocode/tmp/audit-2026-11-13/tests-pinned-yarn.log) |
| Independent native suite | Interrupted; no final test counts or pass verdict | [native output](.octocode/tmp/audit-2026-11-13/native.log) |
| Independent full e2e | Invoked and interrupted; no final test counts or pass verdict | [runner output](.octocode/tmp/audit-2026-11-13/e2e-runner.log) |
| Initial accounting probes | Six failing invariants; two passing controls | [initial observations](.octocode/tmp/audit-2026-11-13/wait-repro.json) |
| Updated accounting probes | **8/8 pass**, after concurrent identity-ledger correction | [updated observations](.octocode/tmp/audit-2026-11-13/wait-repro-current.json) |
| Updated wait regression tests | **57 passed, 1 failed** across three files; all 10 new identity tests pass; A09 remains | [focused results](.octocode/tmp/audit-2026-11-13/current-waits-tests.json) |
| Production dependency audit | Blocked: `registry.npmjs.org` DNS | [dependency audit](.octocode/tmp/audit-2026-11-13/dependency-audit.log) |
| Local documentation targets | 57 Markdown files, 719 local links; zero missing targets | [doc-links.json](.octocode/tmp/audit-2026-11-13/doc-links.json); fragments and 40 external links were not checked |
| Generated reference consistency | Initial RPC drift; latest **4/4 pages match** after concurrent correction | [initial comparison](.octocode/tmp/audit-2026-11-13/reference-drift.json), [current comparison](.octocode/tmp/audit-2026-11-13/reference-drift-current.json) |

The first lint failure was at `models-dev-refresh.test.ts:16`. Concurrent work replaced its forbidden inline type import with a normal type import. The final gate was rerun rather than treating the stale failure as a current defect. No assertion, timeout, retry policy or threshold was weakened.

### Feature coverage ledger

The following maps every native directory to the declared product surface. **Mapped** means inventory/documentation and broad-suite selection; **traced** additionally means deciding implementation spans were inspected. Execution outcomes apply only as recorded below, not to every feature in a group.

| Product surface | Native owners inventoried | Review depth and deciding evidence |
| --- | --- | --- |
| CLI, text/JSON/RPC and inbound ACP | `cli` | Mapped; `packages/coding-agent/package.json:51`, core/e2e configuration; ACP workspace |
| Delegation, roles, batches, capacity, check-ins, budgets, isolation, reports and resumption | `subagents`, `child-sessions`, `external` | Traced wait reducer, progress/report consumers and watchdog; mapped remaining flows through [agent communication](docs/AGENT_COMMUNICATION.md) and native/e2e suites |
| Team messages, reservations, worktrees and landing | `team`, `worktrees`, `worktree-paths` | Traced reservation enforcement; mapped worktree contracts and `TEST_PLAN.md` TC-09–TC-13 |
| Processes, queues, cancellation and orphan recovery | `processes`, `shared` | Traced watchdog deadlines and suspend handling; runtime process inspection blocked |
| Tools, parameters, exposure, permission modes, trust and planning | `permission`, `trust`, `plan`, `tool-input`, `mcp-host` | Traced native permission-owner registry and file effect guards; MCP/architecture boundary checks pass |
| File writes/patches, read receipts, checkpoints, shell and background jobs | `files` | Traced digest checks, atomic commit, reservation recheck and postwrite size check at `files/tool/run.ts:87` |
| Timers, recurring/conditional wakes, cancellation and paid check budgets | `timer` | Traced tool, scheduler, wake details and child accounting; A01–A03; `TEST_PLAN.md` G1–G2 remain relevant |
| Native questions and answer routing | `ask` | Mapped to `askUser`, RPC and e2e cases; remote transport execution limited by sockets |
| Web search/fetch, browser specialization and network protection | `web`, `browser` | Traced approval before cached fetch (`web.ts:204`), bounded fetching and common web guard; physical browser use unverified |
| Local session API and external messages | `api` | Traced default setting, transport choice and capability boundary; A04; socket integration blocked |
| Web workspace, daemon, remote control/view links and settings | `workspace`, `web-daemon`, `remote` | Traced host/origin checks, read-only/admin separation, revocation and authenticated encryption; physical/browser/relay interoperability unverified |
| Sessions, history, archive, memory, recovery and compaction | `sessions`, `history`, `archive`, `memory`, `compaction` | Mapped; session/core, DB, native and e2e suites; traced migration/lock helpers and composed shutdown |
| Skills, instructions, context caching and optimization | `skill`, `native-skills`, `instructions`, `context-optimization`, `prompt-optimization` | Mapped to [context](docs/CONTEXT.md), owner docs and core/native/e2e suite selection; live model comprehension/cache hits unverified |
| Hooks, vendor compatibility, plugins, harness and discovery | `hooks`, `claude-code`, `plugins`, `harness`, `discovery` | Mapped to saved contract fixtures and native/core suites; live third-party host equivalence unverified |
| Providers, routed and local models | `llama` plus `packages/ai` | Mapped; provider suite executes offline fixtures; live inference, account grants and local-model service behavior unverified |
| Terminal/editor, themes, shell completion, reports and profiling | `ui`, `terminal`, `terminal-launch`, `render`, `profiler` | Mapped; TUI/terminal/webview/core tests; no physical terminal, screen-reader or latency benchmark certification |
| Durable backlog, plans, steps, dependencies and board | `backlog` | Mapped; shared contracts, DB queries, native and webview suites; full live multi-process board flow limited by sockets |

Cross-package owners are all included in the repository test runner: `acp`, `agent`, `ai`, `coding-agent`, `common`, `contracts`, `db`, `mcp`, `telemetry`, `terminal`, `tui`, `webview`. [scripts/test-workspaces.mjs](scripts/test-workspaces.mjs):21 enumerates them; every workspace declares a test script. Coding-agent e2e and physical-Chrome tests are explicitly excluded from the native suite (`vitest.octocode.config.ts:10`), so a native pass alone cannot certify them.

### Confirmed defenses and their limits

| Boundary | Evidence inspected | What it establishes | Limit |
| --- | --- | --- | --- |
| Native capability registration | `permission/native-tools.ts:84` | Unknown native tools fail registration without a reviewed permission owner | Registration is not proof of every owner's implementation |
| File commit | `files/tool/run.ts:118`, `:212` | Reservation checks occur before commit; expected bytes are checked by the atomic write; changed target identity is refused | Postwrite verification is a size check; same-size external replacement is detected on a subsequent change, per source comment at `:147` |
| Private network access | `web/web.ts:118`, `:204` | Metadata refusal and permission approval precede cached retrieval | Transport/DNS races still require executable networking tests |
| Daemon authority | `web-daemon/server.ts:182` | Own Host/Origin, bearer capability, view-only method and admin restrictions precede dispatch | Socket-level attack cases blocked here |
| Link revocation | `web-daemon/server.ts:154` | Remote/view tokens rotate and matching tabs are revoked | Existing in-flight effects need explicit race tests |
| Relay confidentiality/integrity | `web-daemon/remote/seal.ts:52`, `:79`, `:88` | Direction-specific per-connection keys and authenticated frames are implemented | This source review is not cryptographic or deployed-relay certification |
| Child liveness | `subagents/process/watchdog.ts:82` | Separate busy/idle limits, intentional holds and suspend adjustment exist | Actual process-tree cleanup cannot be inspected on this host |
| Timer settlement | `timer/scheduler.ts:105`, `:259` | Held timer IDs and stop/cancel suppression exist independently of parent report counts | Does not repair A01–A03 |
| Architectural ownership | Final `check:boundaries`, `check:db-boundary`, `check:mcp-boundary`, typecheck and Knip | Configured structural checks pass | Runtime semantics and uncatalogued entry points are not proven by structural checks |

### Tail risks, downstream effects and uncertainty

These are risk scenarios or coverage gaps, not additional reproduced bugs.

| Scenario | Failure to prevent | Current evidence / uncertainty | Required acceptance evidence |
| --- | --- | --- | --- |
| Late, duplicate or reordered events | Wrong wait settles, false report or lost continuation | Initial A01–A03 probes now pass; concurrent tests add duplicate/matching-ID coverage; complete cross-child/run ordering remains to establish | Typed resource identity, idempotent settlement and run/session ownership tests |
| Cancellation during admission or shutdown | A process starts after stop; a late callback reaches disposed state | Existing `TEST_PLAN.md` G2/B74; ordinary shutdown tests do not enumerate every interleaving | Deterministically gate launch/check/commit boundaries and assert no later owned effects |
| Disk full, power loss or interrupted migration | Acknowledged work disappears or a partial migration replaces usable state | File writer explicitly uses data durability without directory flush (`run.ts:121`); recovery/migration owners exist | Failure injection on disposable stores, including reopen and authoritative-file recovery |
| DB lock contention or migration | UI freezes or peers outlive liveness deadlines | SQLite `BEGIN IMMEDIATE` retries synchronously within its timeout (`db/src/sqlite.ts:48`) | Measure event-loop delay under representative multi-process contention on Node 24 |
| External tools or hooks behave adversarially | Agent policy is mistaken for OS isolation | [SECURITY.md](SECURITY.md):3–5 explicitly disclaims an OS sandbox | Isolate untrusted execution; maintain permission/trust/credential negative tests |
| Repeated recovery after uncertain delivery | A prompt or mutation is replayed twice | API retry/receipt and report-delivery designs exist; complete transport checks blocked | Same-key retry, cancellation-vs-completion, crash-after-commit tests with durable receipts |
| Remote link revocation races a command | A revoked link retains an action already admitted | Tokens rotate; timing of already-running work is a separate question | Define and test admission-versus-completion semantics |
| Passing test totals mask missing surfaces | Release promoted despite skipped providers, failed prerequisites or omitted e2e | A06; runtime/socket constraints; skipped tests are separately retained | Gate on required scenarios and prerequisite availability, not the aggregate pass count |
| Resource exhaustion | Team size, output, cached pages or delayed checks exhaust memory/CPU | Fetch cache/output limits and watchdogs exist; integrated stress not measured | Bound queue lengths/retained records; stress sustained streaming, many children and DB backpressure |

### Dependency evidence

Octocode `securityCheck` queried OSV for the exact manifest versions `undici@8.12.4`, `ws@8.22.0`, `cross-spawn@7.0.6` and `yaml@2.9.0`. The service reported no known affected advisories for those versions. This is a four-package spot check, not proof that dependencies are safe or that the full transitive graph is clean. Primary query service: [OSV](https://osv.dev/); repository dependency versions: [coding-agent manifest](packages/coding-agent/package.json):63.

The complete production audit command failed with DNS before returning an advisory result. It therefore provides **no clean dependency verdict**. Re-run the repository's existing `yarn audit` command where the configured registry is reachable, retain its output and review reachable vulnerable paths before changing versions.

## Recommendations

| Order | Action | Owner | Success criterion | Trade-off / alternative |
| --- | --- | --- | --- | --- |
| 1 — P0 | Retain the concurrent identity-ledger fix and finish its release verification | `subagents/pending-waits.ts`, event consumers; existing B72 | Audit probes already pass; require checked-in regressions plus complete run/session ordering and stable Node 24 execution before full closure | The new derived count is preferable to an independent counter; avoid adding another accounting path |
| 2 — P0 | Close cancellation/shutdown race gaps | Admission, process supervision, timer/file lifecycle; existing B74 | No process, lease, timer, duplicate report or callback starts after disposal across the G2 interleavings | Deterministic gates are more diagnostic than longer sleeps or aggressive retries |
| 2a — P1 | Reconcile the legacy deadline fixture; retain the completed lint correction | A09 owner; A10 already corrected | Model a real identified background result and matching completion, keep the deadline assertions, then pass the focused suite | Do not make anonymous notices settle arbitrary work or weaken the zero-deadline assertion |
| 3 — P1 | Re-run mandatory gates on Node 24 with loopback/Unix sockets and process inspection available | Verification environment | Every required suite and e2e stage reports an outcome, zero unhandled errors, all skips explained, owned resources settled | Retain current results as diagnostic evidence; do not discard failures or lower thresholds |
| 4 — P1 | Correct the API default in `SECURITY.md` | Security documentation | Unix-socket default, opt-in HTTP, global disable setting and Windows behavior agree with implementation and API reference | No runtime default change is needed to correct the fact |
| 5 — P1 | Run core/native/e2e stages independently while preserving overall failure | Test orchestration | Injecting one failing stage does not omit later stages; overall command remains nonzero | Slightly longer failure runs buy complete evidence; intentional fast local checks can remain separate |
| 6 — P2 | Make the isolated launcher use the checked-in Yarn without a fresh Corepack download | `test.sh`, Yarn launcher helper | A new isolated home with registry access disabled reaches test discovery using pinned Yarn | Reuse the existing Yarn command helper; avoid a second package-manager installer |
| 7 — Completed for current comparison | Retain the concurrent RPC generator correction and reference freshness check | `scripts/reference-pages/rpc.ts`; A07 | All four current pages match `renderReferences()`; preserve that result after later edits | Change the generator with the behavior; a successful static gate alone previously missed this drift |
| 8 — P1 | Complete offline build, bundled CLI/installer and platform verification | Build/release owners | Built artifact starts, disposable consumer install runs a scripted session, native binaries load on supported targets | Source tests cannot replace the published artifact check; no publishing is required |
| 9 — P2 | Measure contention, long-session rendering and bounded-resource behavior | DB, TUI, orchestration | Representative Node 24 workload records medians/ranges and worst observed stalls against the test plan's budgets | Do not infer performance from source complexity or historical numbers |

## Next steps

1. Preserve the source checkpoints and evidence below; review the substantial concurrent delta before rerunning on a supported host.
2. Retain and verify the concurrent B72 wait-identity correction and its new deterministic tests. The audit driver is a reproduction aid, not a replacement for checked-in regression coverage.
3. Complete B74's cancellation/admission/disposal interleavings and the duplicate/cross-child wait matrix.
4. Execute the full repository, independent e2e, offline build and consumer-install checks on Node 24. Keep physical UI, live provider/ACP interoperability, Windows/native targets, dependency advisories and performance as explicit remaining gates until exercised.
5. Grant release clearance only after required scenarios have passing evidence and each failed, skipped or blocked check has a recorded disposition.

### Evidence bundle

All command logs and reproduction outputs are under [audit-2026-11-13](.octocode/tmp/audit-2026-11-13/). The initial checkpoint is [before.json](.octocode/tmp/audit-2026-11-13/before.json); initial dirty paths are in [status-before.txt](.octocode/tmp/audit-2026-11-13/status-before.txt). The [execution summary](.octocode/tmp/audit-2026-11-13/execution-summary.json) and [failure index](.octocode/tmp/audit-2026-11-13/failure-index.json) preserve suite counts and failing test identities.

### Final execution ledger

These are observed results from a changing tree on Node 26. Passed counts do not certify skipped scenarios, interrupted suites or the latest source revision. The separate focused runs overlap some broader cases and must not be added to a single distinct-test total.

| Workspace / stage | Passed | Failed | Skipped | Verdict / limitation |
| --- | ---: | ---: | ---: | --- |
| Repository scripts | 209 | 3 | 0 | Socket prerequisites fail |
| ACP | 185 | 0 | 0 | Passed |
| Agent loop | 170 | 0 | 0 | Passed before later agent-loop edits |
| AI/providers | 3,672 | 44 | 863 | Failed; socket errors and timeouts; live providers unverified |
| Coding-agent core | 5,037 | 78 | 17 | Failed; included generator drift subsequently corrected, transport/process restrictions and unresolved watcher failures |
| Common | 123 | 33 | 1 | Failed; socket errors/timeouts and watcher fallback assertion |
| Contracts | 113 | 0 | 0 | Passed |
| Database | 61 | 0 | 0 | Passed; subsequent DB edits still require stable-revision verification |
| MCP | — | — | — | Interrupted; no final counts |
| Telemetry | 27 | 0 | 0 | Passed separately |
| Shell completion | 47 | 0 | 0 | Passed separately |
| Terminal UI | — | — | — | Exit 1; tmux socket EPERM and two performance assertions; dot reporter provides no aggregate test counts |
| Webview | 628 | 2 | 0 | Two 5-second timeouts in backlog flow and long profiler timeline |
| Webview timeout recheck | 5 | 0 | 0 | Both affected files pass with one worker and unchanged timeouts; supports load sensitivity, not a clean full-suite verdict |
| Updated wait focus | 57 | 1 | 0 | All 10 new wait-identity tests pass; legacy deadline fixture A09 fails |
| Native suite | — | — | — | Interrupted; no final counts |
| Full e2e | — | — | — | Invoked and interrupted; no final counts |

The root, native and e2e run controllers completed with interrupt exit 130. The long runs were curtailed after repeated unavailable prerequisites and substantial source drift, rather than consuming further timeout cycles as if they could produce release evidence. A direct OS signal attempt to audit-owned processes was denied; the exec-session interrupt completed the controllers. Process-tree cleanup remains unverified because process inspection is restricted. No unrelated process was targeted.

TUI's performance failures are `regression-markdown-strikethrough.test.ts:158` (block-math scaling) and `visual-truncate.test.ts:80` (CPU budget for a 2 MB result). Their root cause remains unresolved under concurrent host load and the different Node line. They are retained as failures; no threshold was relaxed. Webview's two broad-run timeouts both pass in the isolated recheck: [webview-focused.json](.octocode/tmp/audit-2026-11-13/webview-focused.json).

**Explicitly not completed:** offline build and bundled CLI smoke; consumer install/release rehearsal; MCP conformance/TCK; physical browser, accessibility, real-terminal/image and additional tmux checks; Windows/native-target validation; live provider, external-agent and local-model service tests; production-like migration/power-loss recovery; stable performance benchmarks; and a complete production dependency advisory verdict. No publishing or paid evaluation was performed. These remain acceptance work, not presumed passes.

The final source checkpoint and the complete list of concurrent input changes are in [after.json](.octocode/tmp/audit-2026-11-13/after.json). The base commit is unchanged. The audit's own implementation/test changes remain zero; only its report, diagnostic drivers/evidence and reflection entry were written.
