# RFC: expose Octocode through ACP

Date: 2026-10-23. Implemented locally; live editor/provider checks pending.

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
  Broker->>RPC: start, restore or persist, get_state
  RPC-->>Broker: native session ID
  Broker-->>Client: session response
  Client->>Broker: session/prompt
  Broker->>RPC: prompt
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
  alt turn settles
    RPC-->>Broker: settled turn
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
- List discovers native transcripts with optional canonical-cwd filtering and a cwd-bound cursor. Load resolves an ID in its original workspace and replays textual history **before** publishing the restored session. Resume restores context without replay. Active or restoring IDs cannot be loaded twice; configured session roots are resolved consistently between broker and worker.
- One prompt runs per session. Text, resource links, embedded text and validated images are accepted; links are not fetched, and binary resources or audio are rejected. Public text and bounded tool updates stream in order. A prompt response waits for RPC acceptance and native settlement.
- Native policy creates typed dialog metadata carried by RPC. Only explicit permission dialogs expose allow-once/reject-once options through ACP. Unsupported dialogs, invalid replies and cancellation fail closed. ACP neither forces approval prompts nor changes project trust.
- Cancel aborts the turn and pending approval; a deadline stops an unresponsive worker. Close or disconnect disposes owned workers and pending starts. Unexpected exit fails the active request without replaying uncertain effects. Stdout carries protocol frames; diagnostics use stderr.

## Client MCP and transport boundary

Client MCP definitions on new, load and resume are ephemeral additions through `registerMcpServer`. Stdio uses an absolute executable and literal arguments/environment without a shell. Streamable HTTP and legacy SSE use HTTP(S) URLs and literal headers. Experimental ACP-channel MCP is unsupported; `--no-mcp` rejects client servers. Registration does not prove remote availability.

The adapter places client data in a private temporary manifest read by a static extension/launcher; it never writes `mcp.json` or interpolates client values. It rejects duplicate definitions and native namespace collisions, and removes the manifest after worker stop.

Client HTTP URLs with embedded credentials or fragments are rejected. Shared HTTP transport refuses redirects for POST and shutdown DELETE; legacy SSE requires a same-origin POST endpoint. A server requiring redirection must be configured at its final URL. Authentication and tool authorization stay with native owners.

## Boundaries and evidence

`modes/acp/` owns protocol translation and worker lifetime. `RpcClient` supports the CLI invocation, close notification and owned process-tree cleanup; native policy owners create neutral RPC dialog metadata. The broker adds no network listener or runtime dependency on the older Pi extension.

Fork/delete, client filesystem/terminal delegation, protocol model/mode changes, rich diffs, reasoning/binary projection and general UI dialogs remain unsupported. Offline fixtures do not establish live editor/provider interoperability; the loopback HTTP suite could not bind in the restricted validation environment. See [feature validation](FEATURE_VALIDATION.md) for dated results, [feature coverage](FEATURES.md), [agent communication](AGENT_COMMUNICATION.md) and [editing and debugging](EDITING_AND_DEBUGGING.md) for adjacent work.
