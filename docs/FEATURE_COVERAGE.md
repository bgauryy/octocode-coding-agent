---
status: Confirmed
confidence: medium
question: Which feature surfaces were checked, and what remains unverified?
---

# Feature coverage

## Answer

The audit covers native registration, internal mail, external protocols, core sessions and supporting packages. **Coverage of a feature is not proof of every integration or failure mode.** [Ratings and dated run results](FEATURE_VALIDATION.md) distinguish offline tests, live probes and blocked checks.

## Scope

The [2026-10-24 follow-up](FEATURE_VALIDATION.md#tools-context-and-communication-follow-up--2026-10-24) retraced every native tool family and the MCP/SDK exposure paths, caching/context boundaries, internal communication and ACP. The inventory below remains the earlier broad review; its historical test evidence is not a new run. Octocode dependency tool implementations and live vendor integrations were not exhaustively exercised.

Reviewed on **2026-10-23** against the changing working tree. Inventory comes from [native composition](../packages/coding-agent/src/octocode/index.ts), [agent operations](../packages/coding-agent/src/octocode/agent-tool.ts), [core commands](../packages/coding-agent/src/core/slash-commands.ts) and package exports. Six Sol6 workers split ownership and reviewed each other's corrections. Test names below identify evidence, not a complete test manifest; selected runs overlap the broader suites.

## Evidence

Native source paths are relative to `packages/coding-agent/src/octocode/`; test names refer to `packages/coding-agent/test/octocode/` unless stated otherwise. **Offline** means current source review plus local unit/fixture checks. **Limited** adds an explicit unverified integration.

| Surface | Owner; checked behavior | Evidence / limit |
| --- | --- | --- |
| Research and Octocode MCP | `mcp/`; ownership, discovery, relisting, tool exposure, reconnect | Offline: `mcp-*`, `mcp.test`; live remote combinations unverified |
| Reads and edit guards | `files/tool/`, `read-receipts`, `dedupe`; source coverage, hashes, reservations, stale reads | Offline: `file-*`, `read-dedupe`, `read-receipts` |
| File changes | `files/tool.ts`; edits, writes, operation receipts, diagnostics | Offline: file/feedback tests; multi-edit operations are not atomic transactions |
| Checkpoints and rewind | `files/checkpoint*`; snapshot caps, digest-guarded restoration | Offline: `checkpoint`, `checkpoint-command` |
| Shell and background jobs | `files/bash*`; deadlines, handoff, logs, completion reports, stop and cleanup | Limited: Bash suites; process identity/orphan checks affected by denied `ps` |
| Verification evidence | `files/bash/verification.ts`; exit, signal, mutation freshness | Offline: verification tests; shell/external edits are not tracked revisions |
| Debugger | `debug/`; DAP launch, breakpoints, inspection, cleanup, cancellation | Limited: fixture suites; real LLDB initialized but target launch failed |
| Permission decisions | `permission/`, `tool-gates.ts`; modes, cancellation, effect checks, revocation | Offline: permission suites; tool policy is not an OS sandbox |
| Source trust and provenance | `permission/source-*`, `provenance`, `shared/trust`; trust precedence, rewrites, untrusted input | Offline: source/Claude/trust/provenance suites |
| Prompts and roles | `turn.ts`, `instructions/`; capability selection, role constraints, budgets | Offline: `prompt*`, `instruction-composition`, `turn` |
| Native worker execution | `subagents/`; profiles, capacity, spawn grants, RPC, cancellation, output/report contracts | Offline: `subagent-*`, `subagents` |
| Worker resources | `subagents/process/`; skill/MCP handoff, identity, ownership and cleanup | Limited: inheritance/cleanup suites; listener-dependent MCP inheritance blocked |
| Revival and recovery | `subagents/{linger,parked,handoff*}`; generation checks, authorization, pending and late reports | Limited: linger/report tests; recovery depends on successful persistence and process identity |
| Worktree isolation | `subagents/worktree*`; snapshots, export, pruning and merge boundary | Limited: worktree suites; PID checks require normal host process inspection |
| Team membership and reservations | `team/`; join/leave, leases, file claims, stale cleanup | Limited: Team suites; two PID/start-time checks excluded after host failures |
| Team mail | `team/{mail,inbox,delivery,routing}`; direct/role/broadcast/reply, wake/interrupt, acknowledgments, retries | Offline: Team delivery, efficiency, messages, interrupt and communication regressions |
| Dead letters and sender proof | `team/store/`, `proof.ts`; unread departures, notice acceptance, spill, forged sender rejection | Offline: Team retention, efficiency and communication regressions |
| Native process API | `api/`; discovery, authentication, RPC, event replay, idempotent sends and abort ownership | Limited: pure/receipt tests; Unix socket integration blocked; keys/replay are memory scoped |
| Inbound ACP | `src/modes/acp/`; initialize, session lifecycle, streamed updates, permissions, cancellation, MCP configuration | Limited: default core ACP suites and real CLI lifecycle; no live editor/provider turn |
| Outbound agents | `external/`; ACP/native API connection, prompt, permission forwarding, cancellation and reset | Limited: outbound ACP/manager tests; real external agents not exercised |
| Shared application service | `src/core/application/`; commands, receipt conflicts, bounded replay, session/epoch cursors | Offline: core application tests and workspace stream integration |
| Browser workspace | `workspace/`, `packages/webview/`; authentication, live stream, reconnect, forms, backlog/agent/activity views | Limited: HTTP/WS loopback and jsdom passed; physical browser interaction unverified |
| Browser automation | `browser/`; specialist selection, navigation/network policy, uploads, lifecycle | Limited: offline browser suites; Chrome end-to-end excluded |
| Web retrieval | `web/`; DNS/address policy, redirects, limits, cache | Offline: `web`, `web-security`; live web providers unverified |
| User questions | `ask/`; main-session UI, choices and cancellation | Offline: `ask`; unavailable to child question UI |
| Memory | `memory/`, `agentdb/`; scoped persistence, retrieval, injection and permissions | Offline: memory suites |
| Backlog | `backlog/`, `agentdb/`; hierarchy, dependencies, transitions, history and concurrency | Offline: backlog/entity suites; [entity contracts](ENTITIES.md) remain separate from runs/messages |
| Sessions and history | `sessions/`, `src/core/session-manager/`; persistence, branches, fork/clone, resume, brief, retention | Offline: native session suites and full default core suite |
| Queued user inputs | `src/core/agent-session/input-queue.ts`, reusable Agent queues and terminal `/queue`; inspection, replace/remove/move and selection identity | Offline: queue-management regressions; selective edits preserve custom Team/API messages. Explicit `clearQueue()` retains its existing all-queue clearing semantics |
| Compaction and archive | `compaction/`, core compaction; summaries, retry/recovery, cached context, archive access | Offline: compaction/archive suites and full default core suite |
| Skills and resources | `skills.ts`, core loaders; project trust, precedence, invocation policy and child inventory | Offline: skills/resource-loader/inheritance suites |
| Hooks and plugin adapters | `hooks/`, core plugin runtime; lifecycle, rewrites, permission updates, enablement | Offline: hook/plugin suites; [host compatibility](PLUGINS_MODS_HOOKS.md) is partial |
| Model routing and authentication | `subagents/catalog`, `models-command`, `packages/ai/`; catalog, routing, provider requests/auth/cache | Limited: AI/default core suites; credentialed live tests skipped |
| Status, editor and notices | `ui/`; activity, queued delivery, notifications, editor and status views | Offline: activity/editor/UI/notify/delivery suites |
| Terminal, input and rendering | `packages/tui/`, terminal mode; keys, paste, editor, render and navigation | Limited: TUI/core tests; two reftable filesystem watcher failures remain |
| Generic MCP | `packages/mcp/`, host MCP extension; stdio/SSE/HTTP parsing, redirects, resources and auth state | Limited: offline transport tests; live OAuth/network exchange incomplete |
| Agent loop and provider runtime | `packages/agent/`, `packages/ai/`; streaming, tools, steering, cancellation, retries and conversion | Offline: full package suites; live providers skipped |
| SDK and CLI | `src/index.ts`, `src/core/sdk.ts`, modes; exports, options, resource selection and protocol entry points | Offline: default core suite; standalone factories now cover Bash only |
| Telemetry and shared schemas | `packages/telemetry/`, `packages/contacts/`; event contracts, validation and propagation | Offline: full package suites |
| Build and distribution | root `scripts/`; package boundaries, local artifacts, installer fixtures and version checks | Offline: 36 script tests; registry release still requires sibling dependency publication |

### Command coverage

Commands are inventoried separately from tools. The [command reference](../packages/coding-agent/docs/commands.md) owns the current canonical commands, compatibility aliases and mode restrictions. Child sessions expose a smaller registered set.

`/debug` saves diagnostics; the opt-in `debug` tool controls DAP. `/help` reports the current mode's available commands. `/share` and `/bug` were source/fixture checked; this audit did not publish a gist or submit a report. Custom extension, prompt and skill commands are dynamic.

## Gaps

- Team mail is agent messaging, not a built-in SMTP/Gmail/Outlook service. No email provider was configured or tested.
- A2A remains proposed in the [communication RFC](RFC_COMMUNICATION_PROTOCOL.md). ACP, MCP, DAP and Team delivery keep their own semantics; no universal wire protocol is implemented.
- Live provider/editor ACP, Chrome, real debugger stepping, Windows execution, process-identity cleanup and visual accessibility require additional host/integration runs.
- Native tool diagnostics are advisory; source revision attestation and comparative task/performance benchmarks remain absent.

## Checks

See [validation results](FEATURE_VALIDATION.md) for exact counts, failures, exclusions and peer ratings. Inventory completeness is assessed against runtime registration and package exports, not against the presence of a passing test for every line of code.
