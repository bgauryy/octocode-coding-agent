---
status: Confirmed
confidence: medium
question: What do the native feature implementation and regression checks establish?
---

# Native feature validation

## Answer

The implemented flows have source review and focused regression coverage. **Review rating: 7.8/10**, with live integration and platform gaps. This is an engineering judgment, not a coding-success benchmark or a claim of perfect implementation.

## Scope

Verified on **2026-10-23**, using Node 24.19.0, Yarn 4.18.1 and isolated temporary configuration without provider credentials. The working tree is based on `5630993eac016347e3ae63954ea3bd5559bfa90a` and includes concurrent edits; HEAD alone does not reproduce it. Octocode text and semantic tools traced owners and callers. Six workers reviewed separate boundaries and another worker challenged each lane.

## Evidence

| Boundary | Rating / 10 | Deciding evidence and correction |
| --- | ---: | --- |
| Execution and permissions | 8 | A failing integration test reproduced a nested deadline lost before permission hooks. [Signal forwarding](../packages/coding-agent/src/core/agent-session/tool-calls.ts) now reaches the gate; cancellation prevents execution while the parent remains live. |
| Edits and feedback | 8 | [Parser feedback](../packages/coding-agent/src/octocode/files/feedback/parse.ts) refuses failed/partial and switched-session observations; response roots accept explicit `root` or `base`. [Read snapshots](../packages/coding-agent/src/octocode/files/read-receipts.ts) release failed calls without removing successful evidence before result hooks. |
| Debugging and verification | 7.5 | [DAP lifecycle](../packages/coding-agent/src/octocode/debug/session.ts) closes on abort, exit or termination; buffered frames cannot revive a closed session. Fixtures exercise these races; live adapters remain untested. |
| Agent communication | 8 | [Parked worker restoration](../packages/coding-agent/src/octocode/subagents/linger.ts) preserves a validated browser-mode override while rejecting other profile drift. Revival still needs fresh authorization and generation checks. |
| ACP and MCP | 7.5 | [Transport](../packages/mcp/src/transports/streamable-http.ts) refuses redirects for requests carrying literal/custom headers. ACP rejects credential-bearing/fragment URLs; typed approvals and worker disposal have regression coverage. |
| Prompt projection | 8 | [Turn setup](../packages/coding-agent/src/octocode/turn.ts) separates explicit read-only roles from missing file tools. Shared instructions were condensed while preserving report outcomes and existing size budgets. |

Each peer scored correctness, authorization, lifecycle and evidence from 0–5. Here, 3 means substantial gaps remain; 4 means traced implementation and relevant regressions; 5 requires broader integration evidence. The displayed rating is the mean of these six review judgments. Research, skills, browser, hooks, memory and host/UI ownership were also traced; they were not exhaustively exercised.

Transferable lessons: keep capability selection separate from authority; check transport policy at the actual network sink; reauthorize revived work; preserve mutation evidence across later failures; verify event ordering before attaching cleanup; treat parser/LSP output as advisory without a source-version contract.

## Gaps

- Worktree PID reuse and pending-report claim identity assertions still fail where `ps` is prohibited; owners conservatively retain uncertain processes. Detached descendant cleanup needs a normal host.
- Loopback HTTP tests cannot bind `127.0.0.1` here (`EPERM`). Offline transport fixtures pass, but this does not validate real network interoperability.
- No live provider/editor, real language DAP adapter, Chrome session, Windows execution or comparative task/performance benchmark ran.
- Documentation links and HTML generation were checked; browser render inspection was unavailable because local-file previews are blocked. Mermaid visual rendering remains unverified.
- Native-file revisions do not observe shell/external edits. Parser/LSP publication freshness is not attested. Worktree capture is best effort against external writers. These are documented limits, not passing test claims.

## Checks

Counts are individual runs and overlap; **do not sum them**.

| Current audit run | Result |
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

These dated results preceded the current audit and are retained as history, not new runs. Earlier failures were not waived.

| Phase | Recorded results |
| --- | --- |
| Initial source audit | 466 passed, 3 PID-related failures across 31 files. Root formatting failed; TypeScript, lint and separately run browser-import/workspace/boundary checks passed. Skills follow-up: 26 passed. Browser-dialog follow-up: 1 passed, 7 failed and 7 uncaught errors after loopback bind refusal. |
| Initial ACP exposure | Root check and offline build passed. ACP/RPC/CLI: 194 passed; native permissions/outbound ACP: 165 passed, 1 PID-identity failure. Live interoperability was not run. |
| Six-feature implementation | Root check, offline build, schema/reference generation and CLI help passed. Core ACP/RPC/session/MCP: 231 passed; native selection: 293 passed; SSE: 12 passed; native MCP config: 3 passed, 39 unselected. Final peer-fix selection: 98 passed, 2 PID failures. Wider native run: 316 passed, 3 failures including detached-helper cleanup. ACP owner: 88 passed; final history selection: 8 passed. |

Current behavior is documented in [Features](FEATURES.md), [execution and permissions](EXECUTION_AND_PERMISSIONS.md), [communication](AGENT_COMMUNICATION.md), [editing and debugging](EDITING_AND_DEBUGGING.md), and the [ACP design](RFC_ACP_EXPOSURE.md).
