# RFC: expose Octocode through ACP

Implemented; current reference: [packages/coding-agent/docs/acp.md](../packages/coding-agent/docs/acp.md)

Date: 2026-10-23; updated 2026-10-25. Implemented locally. A real configured provider session and independent ACP compatibility checks now supplement the source CLI lifecycle tests. See [dated validation](FEATURE_VALIDATION.md) for exact scope; editor and cross-platform interoperability remain unverified.

## Decision and ownership

`octocode --mode acp` is an inbound Agent Client Protocol v1 stdio broker, distinct from Octocode's outbound ACP client. It translates protocol frames and events while one RPC child per session owns execution, credentials, workspace trust, persistence, MCP and native permission decisions. There is no second agent loop or database. The [ACP reference](../packages/coding-agent/docs/acp.md) owns launch instructions and the contract.

Process isolation preserves process-wide native ownership, at the cost of startup per session. Eight sessions, including pending creations, are allowed per connection. Durable IDs come from native transcripts; active workers belong to the connection. The pinned `@agentclientprotocol/sdk` stable v1 API owns protocol version and request lifecycle.

```mermaid
sequenceDiagram
  participant Client as ACP client
  participant Broker as Stdio broker
  participant RPC as RPC child
  participant Gate as Native gate
  Client->>Broker: initialize; session/new or load
  Broker->>RPC: start with new or validated saved transcript
  RPC-->>Broker: private canonical identity before startup hooks
  Note over Broker,RPC: Saved replay precedes live startup output; UI replies and cancellation remain available
  Broker->>RPC: persist and get_state after initialization
  Broker-->>Client: session response
  Client->>Broker: session/prompt
  Broker->>RPC: correlated completion-aware prompt
  RPC->>Gate: native tool permission check
  alt explicit approval required
    Gate-->>RPC: typed allow/reject dialog
    RPC-->>Broker: extension UI request
    Broker->>Client: request_permission
    Client-->>Broker: selected option or cancellation
    Broker-->>RPC: once-only choice or cancelled
  end
  RPC-->>Broker: public updates
  Broker-->>Client: ordered updates
  alt dispatch completes
    RPC-->>Broker: tracked work settled; correlated response
    Broker-->>Client: prompt response
  else session/cancel before settlement
    Client->>Broker: cancel notification
    Broker->>RPC: abort turn and pending approval
    RPC-->>Broker: settled or cancellation deadline
    Broker-->>Client: cancelled prompt response
  end
  opt session/close, EOF or signal
    Note over Broker: Connection or session ends
    Broker->>RPC: abort and bounded process-tree stop
  end
```

## Protocol behavior

- Initialize advertises v1 without starting a worker. New sessions require an absolute existing cwd and RPC readiness; the broker does not auto-trust it. Additional workspace roots are unsupported.
- List discovers native transcripts with optional canonical-cwd filtering and a cwd-bound cursor. Load resolves an ID in its original workspace and replays supported history **before** publishing the restored session: text, stored images, visible extension messages and bounded textual tool results. Resume restores context without replay. An idle active session may be loaded or resumed on the same connection; its worker is replaced so current MCP definitions apply. Busy or concurrently restoring sessions are refused. Configured session roots are resolved consistently between broker and worker.
- One prompt runs per session. Text, resource links, embedded text and validated images are accepted; links are not fetched, and binary resources or audio are rejected. Public text and bounded tool updates stream in order. A prompt response waits for the correlated RPC dispatch to complete, including nested extension sends and deferred follow-ups. A handled command with no model work completes immediately.
- Native policy creates typed dialog metadata carried by RPC. Only explicit permission dialogs expose allow-once/reject-once options through ACP. Unsupported dialogs, invalid replies and cancellation fail closed. ACP neither forces approval prompts nor changes project trust.
- Cancel aborts the turn and pending approval; a deadline stops an unresponsive worker. Close or disconnect disposes owned workers and pending starts. Unexpected exit fails the active request without replaying uncertain effects. Stdout carries protocol frames; diagnostics use stderr.

Work started independently through the local API or Team delivery is observed through native `session_dispatch` events and relayed to the ACP client, including permission requests. Overlapping ACP prompts are refused without terminating that work; `session/cancel` can stop the observed turn. The [SDK guide](../packages/coding-agent/docs/rpc.md) owns acceptance versus completion semantics.

RPC event subscription and stdin handling precede extension startup. An ACP-only private identity frame lets the broker register the worker for cancellation/close and release output after saved replay, without waiting for hooks that may themselves await permission. UI replies are handled immediately; ordinary commands retain initialization ordering, while ACP abort can interrupt startup. The frame is consumed by the RPC connection's internal callback, never projected as an agent event. Pending workers count toward the session limit exactly once and remain owned during disconnect.

Restored workers start directly from the validated transcript, and replay snapshots precede startup hooks so live output is not duplicated. ACP-owned extension controls reject native new/switch/fork actions before mutation; uncaught command errors become failed ACP prompts without destroying the conversation. Broken stdout follows the same owned-worker cleanup path as disconnect, before process exit.

## Client MCP and transport boundary

Client MCP definitions on new, load and resume are ephemeral additions through `registerMcpServer`, owned by the shared `packages/mcp/src/` host and client. Client definitions explicitly enable that host when automatic extensions are disabled. Stdio uses an absolute executable and literal arguments/environment without a shell. Streamable HTTP and legacy SSE use HTTP(S) URLs and literal headers. Experimental ACP-channel MCP is unsupported; `--no-mcp` rejects client servers. Registration does not prove remote availability.

The adapter places client data in a private temporary manifest read by a static extension/launcher; it never writes `mcp.json` or interpolates client values. It rejects duplicate definitions and native namespace collisions, and removes the manifest after worker stop.

Client HTTP URLs with embedded credentials or fragments are rejected. Shared HTTP transport refuses redirects for POST and shutdown DELETE; legacy SSE requires a same-origin POST endpoint. A server requiring redirection must be configured at its final URL. Authentication and tool authorization stay with native owners.

## Boundaries and evidence

The private [`packages/acp` workspace](../packages/acp/README.md) owns protocol translation and worker lifetime in `src/server/`, and outbound connections/capture in `src/client/`. It is compiled into coding-agent's `dist/acp/`; it remains coupled to host services and is not a standalone SDK. `RpcClient` supports the CLI invocation, close notification and owned process-tree cleanup; native policy owners create neutral RPC dialog metadata. The broker adds no network listener or runtime dependency on the older Pi extension.

Fork/delete, client filesystem/terminal delegation, protocol model/mode changes, rich diffs, reasoning/binary tool projection and general UI dialogs remain unsupported. The 2026-10-25 run exercised a configured provider and local API/ACP coexistence. Earlier restricted-host failures remain dated evidence; neither fixture nor sampled provider checks establish every editor/vendor integration. See [feature validation](FEATURE_VALIDATION.md) for dated results, [feature coverage](FEATURE_COVERAGE.md), [agent communication](AGENT_COMMUNICATION.md) and [editing and debugging](EDITING_AND_DEBUGGING.md) for adjacent work.
