---
status: Needs work
confidence: medium
question: What do the native feature implementation and regression checks establish?
next: Resolve concurrent repository check failures and rerun restricted process and live integration checks on a suitable host.
---

# Native feature validation

## Answer

The **2026-10-24 tools, context and communication follow-up** repaired verified cache, context-budget, cancellation, routing, report and prompt defects. Focused regressions pass; repository-wide checks remain blocked by concurrent source changes and some host-dependent tests fail. A2A is still a proposal. This is not an all-green production certification or a claim that every tool is perfect.

**Earlier broad feature review: 7.6/10.** The [registration-driven coverage matrix](FEATURE_COVERAGE.md) includes mail, all native domains, command surfaces and supporting packages. That follow-up fixed shared message rejection propagation, native API receipt handling, browser stream continuity, Bash report failure visibility and user-queue edits that dropped unrelated mail. Real ACP stdio session lifecycle passed; real LLDB completed its DAP handshake but could not launch the target. Scores are historical engineering judgments, not coding-success benchmarks. The earlier six-boundary review was 7.8/10 and is not directly comparable.

## Changes

### Tools, context and communication follow-up — 2026-10-24

Reviewed the changing working tree with Node **24.19.0** and Yarn **4.18.1**. Four bounded reviews covered provider caching/context, internal communication, ACP and tool boundaries; the integration review covered effective prompts and consumers. Existing staged and untracked work was preserved. No live provider credentials were used. Counts below describe separate runs and overlap; do not add them into one total.

| Location | Finding and behavioral effect | Severity | Repair |
| --- | --- | --- | --- |
| [MCP resources](../packages/coding-agent/src/extensions/mcp/resources.ts) | Server payloads could override the trusted routing identity; trimming opaque cursors could change which page was requested | High | Connection-owned server tags win; continuation bytes remain exact and require a server |
| [MCP management](../packages/coding-agent/src/extensions/mcp/manage-tool.ts), [debugger](../packages/coding-agent/src/octocode/debug/tool.ts), [Team send](../packages/coding-agent/src/octocode/team/session/send.ts) | Canceled operations could still mutate server state, launch an adapter or resume a parked worker during approval | High | Check abort before effects and carry combined run/tool cancellation through approval and revival |
| [OpenAI-compatible caching](../packages/ai/src/api/openai-completions/cache-control.ts) | Explicitly disabled instruction caching was reenabled by a default; schema data named `cache_control` consumed fake breakpoint slots | Medium | Preserve the disabled layer; reuse the marker counter that excludes opaque schema payloads |
| [Context budget](../packages/coding-agent/src/core/compaction/tokens.ts) | Same-name replacement tool schemas contributed no new declaration estimate | Medium | Compare declaration content, including constrained sampling, while excluding hidden declarations |
| [Child reports](../packages/coding-agent/src/octocode/subagents/report.ts) | An empty final follow-up could inherit an earlier task's `done` outcome | Medium | Record an incomplete follow-up while retaining prior evidence; a successful retry clears the failure |
| [ACP history](../packages/coding-agent/src/modes/acp/history.ts) and [MCP handoff](../packages/coding-agent/src/modes/acp/mcp.ts) | Restored tool output was silently cut; valid `__proto__` headers disappeared and escaped duplicate checking | Medium | Share the live bounded result projector; validate header names with a Set and preserve literal keys |
| [Outbound ACP capture](../packages/coding-agent/src/octocode/external/acp-output.ts) | Aggregate turn updates and connection stderr grew without a retention bound | Medium | Bound previews and private overflow archives, expose missing evidence and preserve terminal outcomes |
| [Prompt assembly](../packages/coding-agent/src/core/system-prompt.ts), [native policy](../packages/coding-agent/src/octocode/instructions/policy.ts) and [turn setup](../packages/coding-agent/src/octocode/turn.ts) | Hidden or absent tools were recommended; path refusal suggested switching tools; overlapping narrative rules consumed context | Medium | Route by actual exposure, distinguish unavailable tools from permission refusals, and consolidate guidance into five concerns |
| [Archive tool](../packages/coding-agent/src/octocode/compaction/archive-tool.ts) | Recovery text recommended the removed `read` tool | Low | Require an available reader and appropriate permission without changing archive scope |

The [instruction reference](../packages/coding-agent/docs/instructions.md) records the five concerns: work and verification, context and research, delegation, safety, and communication. Child outcomes and protocol fields remain unchanged. Source/fixture checks establish emitted instructions and routing; no behavioral model evaluation or token/cost savings measurement was run.

| Run | Observed result |
| --- | --- |
| Native prompt, role/context and isolated-child selection | 28 passed / 5 files |
| Core prompt assembly, updates, discovery, contribution and context-clone selection | 51 passed / 6 files; hidden-reader regressions failed before repair |
| AI cache/context/transcript selection | 312 passed, 4 live-provider tests skipped / 15 files |
| Core cache/compaction selection | 141 passed, 2 live summarization tests skipped / 15 files; after declaration-budget repair, 82 passed and 2 skipped / 9 overlapping files |
| MCP management, resources, catalog, discovery and SDK seams | 119 passed / 8 files; broader attempt had 148 passed and one localhost `listen EPERM` failure/timeout |
| Debugger lifecycle and archive | 14 passed / 2 files; broader native attempts were interrupted after restricted process/network cases failed or stalled |
| Team mail, reports and recovery | 184 passed, 2 PID-reuse failures / 12 files; `ps` returned `operation not permitted`; assertions retained |
| Additional worker lifecycle/authorization and final report repair | 140 passed / 12 files; overlaps the earlier report suite |
| Shared contacts contracts | 24 passed / 3 files |
| Inbound ACP | 80 passed / 7 files; subsequent history/header tests: 19 passed / 2 overlapping files |
| Outbound ACP initial selection | 24 passed, 1 crash-recovery failure because process identity was `unknown` under denied `ps` |
| Final outbound ACP retention checks | 23 existing backend cases, 5 capture regressions and 2 stdio overflow regressions passed across focused runs; overlap the initial backend selection |
| Repository check | Initial run stopped at concurrent expanded message-content types. Final rerun reached three diagnostics in `tui-application-content.test.ts` and `SessionComposer.tsx`; not an all-green check |
| Separate lint, formatting and bundle checks | Lint reported concurrent UI/test errors; format check reported 29 files; workspace bundle was stale. Modified audit files passed scoped checks |
| Browser import and package-boundary checks | Passed |
| Documentation | 109 local links/anchors passed across six edited documents. Strict HTML generation passed; visual inspection was blocked because the browser URL policy disallows local file URLs |

Remaining limits: exact tokenizer accounting, measured live cache hits/billing, live editor/provider ACP and browser behavior are not established. Core context fallback remains an estimate. MCP `readOnlyHint` is still trusted for manual-mode read classification, as documented in [permissions](../packages/coding-agent/docs/permissions.md); a mislabeled server can therefore avoid a mutation prompt. Attached/persistent Chrome observes some private WebSocket traffic rather than blocking it. External Octocode dependency tool bodies were not exhaustively audited.

Internal Team mail acknowledges model-context inclusion, API acceptance acknowledges dispatch, and a child report records a task outcome. These meanings remain separate. ACP uses its existing session and permission lifecycle; no A2A transport or universal task protocol was introduced. See [agent communication](AGENT_COMMUNICATION.md).

## Scope

Reviewed on **2026-10-23**, using Node 24.19.0, Yarn 4.18.1 and isolated temporary configuration without provider credentials. The latest working tree is based on `cdc32be2f1b406c96864d01c2bdcafedc4b62869` with extensive concurrent edits; HEAD alone does not reproduce it. Four Sol6 workers reviewed current boundaries and challenged each other's findings. Octocode text and semantic tools traced owners and callers. The earlier six-worker audit used `5630993eac016347e3ae63954ea3bd5559bfa90a`.

The subsequent all-feature follow-up used **six Sol6 workers**, registration and export inventories, full default core/runtime/UI package tests, broader native selections and peer reviews. Current source changed during the runs; affected fixes received focused reruns. Historical counts below describe their own snapshots.

## Evidence

| Current feature | Score / 10 | Strength; remaining limitation |
| --- | ---: | --- |
| Research and Octocode MCP | 7.5 | [Native research ownership](../packages/coding-agent/src/octocode/mcp/octocode.ts), discovery and bounded output; live server/provider combinations remain sampled. |
| Editing and feedback | 8 | [Guarded edits and receipts](EDITING_AND_DEBUGGING.md); diagnostics cannot attest the exact source revision. |
| Permissions and prompts | 8 | [Native authority checks](EXECUTION_AND_PERMISSIONS.md) and capability-aware prompts; tool policy is not an OS sandbox. |
| Workers and internal communication | 8 | [Durable mail, revival and relay](AGENT_COMMUNICATION.md); asynchronous rejected handoffs now retry without replaying model-acknowledged mail. Cross-host delivery is not provided. |
| External ACP | 7.8 | [Session broker](../packages/coding-agent/src/modes/acp/broker.ts), typed approvals and actual CLI lifecycle; no real provider/editor turn. |
| Generic MCP | 7.5 | [Reusable transports](../packages/mcp/README.md) and redirect protection; live remote authentication/interoperability incomplete. |
| Debugging and verification | 8 | [DAP lifecycle](../packages/coding-agent/src/octocode/debug/session.ts), launch-error precedence and verification receipts; real target launch failed. |
| Browser | 7 | [Network and upload checks](../packages/coding-agent/src/octocode/browser/tool/checks.ts); live Chrome not rerun. |
| Native skills | 7.5 | [Scoped resource loading](../packages/coding-agent/src/octocode/skills.ts); external-host compatibility is separate. |
| Hooks | 7 | [Typed interception](../packages/coding-agent/src/octocode/hooks/register.ts), explicit enablement; broader executable-hook integrations unverified. |
| Memory and backlog | 7.5 | [Scoped memory](../packages/coding-agent/src/octocode/memory/inject.ts), [transactional work records](ENTITIES.md); live concurrent UI/agent coverage incomplete. |
| Terminal, web and shared runtime | 8 | [Host application port](INTERFACE_ARCHITECTURE.md), bounded replay and receipts; visual interaction not rerun. |
| AI adapters | 7 | [Provider request ownership](../packages/ai/src/models/requests.ts); broad inventory/sample review, not every live API. |

Each score considers correctness, authority boundaries, lifecycle/recovery and validation evidence, up to 2.5 points each. The overall is the rounded mean of these 13 judgments. Plugin/Claude-host compatibility is a separate **5/10 completeness judgment** from the [compatibility matrix](PLUGINS_MODS_HOOKS.md); it does not lower native skills' score. **A2A support is absent**, not a tested low-quality implementation. [The communication RFC](RFC_COMMUNICATION_PROTOCOL.md) recommends shared internal contracts and separate ACP/A2A/MCP/DAP adapters.

### Earlier six-boundary review

| Boundary | Rating / 10 | Deciding evidence and correction |
| --- | ---: | --- |
| Execution and permissions | 8 | A failing integration test reproduced a nested deadline lost before permission hooks. [Signal forwarding](../packages/coding-agent/src/core/agent-session/tool-calls.ts) now reaches the gate; cancellation prevents execution while the parent remains live. |
| Edits and feedback | 8 | [Parser feedback](../packages/coding-agent/src/octocode/files/feedback/parse.ts) refuses failed/partial and switched-session observations; response roots accept explicit `root` or `base`. [Read snapshots](../packages/coding-agent/src/octocode/files/read-receipts.ts) release failed calls without removing successful evidence before result hooks. |
| Debugging and verification | 7.5 | [DAP lifecycle](../packages/coding-agent/src/octocode/debug/session.ts) closes on abort, exit or termination; buffered frames cannot revive a closed session. Fixtures exercise these races; live adapters remain untested. |
| Agent communication | 8 | [Parked worker restoration](../packages/coding-agent/src/octocode/subagents/linger.ts) preserves a validated browser-mode override while rejecting other profile drift. Revival still needs fresh authorization and generation checks. |
| ACP and MCP | 7.5 | [Transport](../packages/mcp/src/transports/streamable-http.ts) refuses redirects for requests carrying literal/custom headers. ACP rejects credential-bearing/fragment URLs; typed approvals and worker disposal have regression coverage. |
| Prompt projection | 8 | [Turn setup](../packages/coding-agent/src/octocode/turn.ts) separates explicit read-only roles from missing file tools. Shared instructions were condensed while preserving report outcomes and existing size budgets. |

In that earlier review, each peer scored correctness, authorization, lifecycle and evidence from 0–5. Its 7.8/10 aggregate covered those six boundaries. Research, skills, browser, hooks, memory and host/UI ownership were traced but not exhaustively exercised.

Transferable lessons: keep capability selection separate from authority; check transport policy at the actual network sink; reauthorize revived work; preserve mutation evidence across later failures; verify event ordering before attaching cleanup; treat parser/LSP output as advisory without a source-version contract.

## Gaps

- Worktree PID reuse and pending-report claim identity assertions still fail where `ps` is prohibited; owners conservatively retain uncertain processes. Detached descendant cleanup needs a normal host.
- Native API Unix socket tests failed at `listen EPERM`; selected MCP HTTP listener tests were also blocked in earlier runs. The latest workspace HTTP/WebSocket test successfully bound `127.0.0.1` and passed, so a blanket claim that every loopback listener is unavailable would be incorrect. Live remote interoperability remains unverified.
- Two unchanged core reftable watcher tests fail both in the full run and in isolation. Filesystem event restrictions are the likely cause; this is not a proven diagnosis or a waived test.
- Real source CLI ACP initialization, new/list/close/load/close passed. No live provider/editor prompt, Chrome session, Windows execution or comparative task/performance benchmark ran.
- Installed `lldb-dap` initialized against a compiled scratch C target, but launch failed; independent LLDB also failed to start it. Host restrictions are the likely cause, not a proven diagnosis. No real breakpoint stop, stack/variables, stepping or continuation was verified. These runs still used the managed execution policy.
- Documentation links and HTML generation were checked; browser render inspection was unavailable because local-file previews are blocked. Mermaid visual rendering remains unverified.
- Native-file revisions do not observe shell/external edits. Parser/LSP publication freshness is not attested. Worktree capture is best effort against external writers. These are documented limits, not passing test claims.

## Checks

Counts are individual runs and overlap; **do not sum them**.

### Latest all-feature follow-up — 2026-10-23

| Run | Result |
| --- | --- |
| Agent loop package | Initially 106 passed; final full rerun after selective queue operations: 108 passed / 5 files |
| AI package | 1,667 passed, 857 skipped / 187 files; credentialed integrations among skips. Later stable-system-head fixture: 8 passed |
| Full default coding-agent suite | 3,426 passed, 49 skipped, 2 failed / 391 files; failures are the two reftable watcher cases |
| Additional native inventory selection | 2,050 passed, 14 skipped, 23 failed / 166 files; four failures were delivery regressions running while the fix was being applied and passed afterward. Remaining 19 concern process identity/descendant cleanup or Unix socket startup; their host prerequisites failed |
| Final Team mail/membership suites | 198 passed, 4 skipped / 17 files; two preexisting skips and two explicitly excluded PID reuse cases. Unfiltered failures are retained in the earlier run log |
| Final composed delivery/API/Bash check | 36 passed / 5 files, including all four delivery cases above; final API owner run subsequently passed 15/15 after one additional unkeyed receipt assertion |
| New queued-input API | 9 passed, including mixed user/custom-message removal and reordering; enclosing queue/steering/interruption/compaction selection: 41 passed / 4 files. The original fixture stalled before seeding its tool response and was corrected |
| Terminal `/queue` | 18 passed; targeted edits, attachment preservation, compaction selections and stale items. Cancelling an action returns to the list; cancelling the list closes it |
| Native communication selection | 152 passed / 10 files before final API additions; six additional pure API registry/replay tests passed |
| Standalone MCP offline selections | 48 passed; listener-dependent HTTP/OAuth cases excluded and not claimed as verified |
| File guards and editing | 260 passed / 8 files |
| Permission, source policy and trust | 481 passed / 34 files |
| Browser; web retrieval; debugger fixtures | 232 passed / 16 files; 144 passed / 2 files; 30 passed / 5 files |
| Bash broad selection | 321 passed, 9 failed / 16 files; process identity/orphan lifecycle prerequisites affected by denied `ps`, including one timeout. Final focused report/verification selection: 56 passed |
| Resource, session, UI and native feature selections | Worker reported 604 passed / 37 selected files; no complete retained command manifest, so this is supplementary evidence rather than an auditable aggregate |
| Contacts; webview; telemetry; TUI | 24; 176; 61; 1,285 passed respectively |
| Workspace HTTP/WebSocket stream | 4 passed, including text batching with status, tool and different-message boundaries |
| Repository scripts | 36 passed, including local artifact/install fixtures; no registry publication |
| Final offline build | Passed after the five fixes; 105 bundle files, 10.8 MiB |
| Final `yarn run check` | Passed: TypeScript, lint, format, browser imports, workspace freshness and package boundaries. Earlier passes were interrupted by concurrently introduced type/format errors; those were corrected |
| Documentation | 213 local links/anchors passed; coverage and validation reports passed strict HTML generation; visual rendering unverified |

Five corrections were cross-reviewed:

- **Shared delivery:** the installed wrapper discarded send promises, hiding rejection from Team, API and Bash callers. It now preserves the return contract, removes rejected queued entries and waits for TUI re-append acceptance before reporting success. Generation guards prevent late callbacks affecting a replacement session. A composed Team test verifies retry and model-context acknowledgment through the wrapper.
- **Native API:** failed asynchronous sends retain an uncertain key to prevent duplicate dispatch, release failed active ownership and reject waiting clients. Session/settlement guards ignore stale and post-settlement callbacks, including unkeyed sends.
- **Workspace stream:** coalesced text events identify their exact sequence range. Only adjacent full-text deltas can bridge it; missing status/tool events still cause resynchronization. The public frame schema export remains available.
- **Bash reports:** a rejected completion report produces an active-session warning with job ID and log path. It does not automatically replay possibly consumed output, and does not guarantee model-context delivery after failure.
- **User input queue:** targeted user removal/reordering previously cleared the underlying queue and lost unrelated custom Team/API messages. Identity-based queue operations now preserve those messages and their relative order; selected inputs can no longer be edited. A regression reproduced the message loss before the fix.

Peer judgments: **8.5/10** for Team mail, API receipts and central delivery; **8.5/10** for the stream correction after bundle regeneration; **8/10** for the bounded Bash fallback; **9/10** for selective queue edits after mixed-message regressions. These judge the reviewed implementation/evidence, not coding task success. Review feedback caught failed active ownership, stale session callbacks, unkeyed settlement and a public export regression before completion.

### Earlier communication review — 2026-10-23

| Run | Result |
| --- | --- |
| Application port, engine, projection and terminal adapter | 26 passed / 4 files |
| Shared application and workspace contracts | 4 passed / 2 files |
| Inbound ACP protocol, history, permission, MCP and CLI tests | 79 passed / 7 files; includes real CLI/RPC with a synthetic turn fixture |
| Separate actual ACP source CLI probe | Initialize, new, list, close, load and close passed; native transcript created; exit 0; no provider prompt |
| Outbound ACP; child permission relay | 23 passed; 22 passed |
| Team delivery and interrupt peer check | 48 passed, 1 explicitly excluded PID/start-time test; an earlier full run failed that test under the `ps` restriction |
| Final Team delivery, interrupt, efficiency, retention and message suites | 77 passed, 1 explicitly excluded PID/start-time test; includes all four new async-delivery regressions |
| DAP launch ordering, protocol, session and tool tests | 30 passed / 5 files; actual LLDB rerun preserved the original launch error and closed pending requests; target launch still failed |
| `yarn run check`; `yarn run build:offline` | Both passed after all three fixes; broader live checks remain open |
| Updated feature documents | 104 local links/anchors passed; RFC and ratings strict HTML generation passed; visual rendering unverified |

Three regressions failed before their fixes: rejected `sendMessage` stranded handed mail; rejected dead-letter notices were prematurely marked notified; and a secondary DAP configuration failure masked the original launch error. Mail now retries unacknowledged handoffs while ignoring old-generation callbacks, notices wait for host acceptance, and launch errors survive concurrent configuration. Host acceptance of a notice remains distinct from model-context acknowledgment of Team mail.

Peer judgments were 8.2/10 for the mail fix, 8/10 for the DAP fix and 8/10 for the RFC. Review corrections clarified owner-specific contracts, per-recipient delivery records, proposed task lineage and the limits of existing tests. These assess the review artifacts, not measured agent intelligence or comparative coding performance.

### Earlier architecture audit — 2026-10-23

| Earlier audit run | Result |
| --- | --- |
| Shared execution, nested calls, extension runner and user-shell failure handling | 80 passed / 4 files |
| Permissions, source trust, hooks and research/skill exposure | 86 passed / 12 files |
| Edit receipts, anchors, parser/LSP feedback | 85 passed / 4 files |
| Debugger, Bash and verification | 72 passed / 6 files |
| Worker restore; profile and spawn grants | 20 passed; 23 passed |
| Private child resource cleanup, partial writes and file ownership | 5 passed; handoff helper extracted to keep its caller below 400 lines |
| Full-session MCP inheritance | 2 failed at loopback bind with `listen EPERM`; fixture now rejects startup errors instead of timing out |
| Report notices and stop rejection | 5 passed across 2 files |
| Pending-report recovery | 22 passed, 2 process-identity failures; corrected the incremental-read test to inspect byte length and file position |
| Worktree suite | 26 passed, 2 failed under the PID restriction above |
| Prompts, read-only roles and unchanged size budgets | 21 passed / 4 files |
| ACP protocol, persistence, permissions and CLI | 86 passed / 8 files |
| Offline SSE and HTTP redirect tests | 15 passed |
| `yarn run check` | Passed: TypeScript, lint, format, browser imports, workspace freshness and package boundaries |
| `yarn run build:offline` | Passed |
| Replacement documentation | 81 local targets/anchors passed; six Mermaid blocks; strict HTML generation passed for six pages; visual rendering unverified |

The focused native command is `yarn vitest run --config vitest.octocode.config.ts <test paths>` from `packages/coding-agent`; core and ACP tests use its default Vitest config. MCP transport tests run from `packages/mcp`. The root README and package guides own reproducible setup.

### Retained earlier runs — 2026-10-23

These dated results preceded both reviews above and are retained as history, not new runs. Earlier failures were not waived.

| Phase | Recorded results |
| --- | --- |
| Initial source audit | 466 passed, 3 PID-related failures across 31 files. Root formatting failed; TypeScript, lint and separately run browser-import/workspace/boundary checks passed. Skills follow-up: 26 passed. Browser-dialog follow-up: 1 passed, 7 failed and 7 uncaught errors after loopback bind refusal. |
| Initial ACP exposure | Root check and offline build passed. ACP/RPC/CLI: 194 passed; native permissions/outbound ACP: 165 passed, 1 PID-identity failure. Live interoperability was not run. |
| Six-feature implementation | Root check, offline build, schema/reference generation and CLI help passed. Core ACP/RPC/session/MCP: 231 passed; native selection: 293 passed; SSE: 12 passed; native MCP config: 3 passed, 39 unselected. Final peer-fix selection: 98 passed, 2 PID failures. Wider native run: 316 passed, 3 failures including detached-helper cleanup. ACP owner: 88 passed; final history selection: 8 passed. |

Current behavior is documented in [Features](FEATURES.md), [execution and permissions](EXECUTION_AND_PERMISSIONS.md), [communication](AGENT_COMMUNICATION.md), [editing and debugging](EDITING_AND_DEBUGGING.md), and the [ACP design](RFC_ACP_EXPOSURE.md).
