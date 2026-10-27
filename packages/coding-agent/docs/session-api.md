# Local session API

Use `octocode-api` to send messages to a running Octocode host, read its status, watch events and request cancellation. The API is opt-in and local to the machine. It is separate from [Agent Client Protocol](acp.md): an ACP client launches an agent process; this API attaches to an already running host.

## Start and discover

From the repository root, start a terminal session:

```sh
OCTOCODE_API=1 yarn start
```

In a second terminal in the same checkout:

```sh
yarn node packages/coding-agent/src/octocode/api/cli.ts list
yarn node packages/coding-agent/src/octocode/api/cli.ts status --to <instance-id>
```

Replace `<instance-id>` with an ID from `list`. Installed builds use `octocode-api` instead of `yarn node packages/coding-agent/src/octocode/api/cli.ts`. The commands below use that installed name.

`/api` shows status inside an interactive session. `/api on` starts the API, `/api on http` also enables loopback HTTP on an available port, and `/api off` stops it. Subagents do not expose their own API.

`OCTOCODE_API=1` enables a private Unix socket on Unix-like systems; Windows uses loopback HTTP on an available port. `OCTOCODE_API_HTTP=0` enables HTTP on an available port, even without `OCTOCODE_API=1`. A numeric value selects a port from 0 to 65535. See [environment variables](environment-variables.md) and the [configuration map](../../../CONFIGURATIONS.md) for configuration and discovery storage.

An **instance ID** identifies a running API endpoint. `status.sessionId` identifies its current conversation. They are different IDs. Prefer explicit `--to` in scripts; if omitted, the CLI selects the only instance or the unique instance in the current directory and rejects ambiguity.

## Send and receive a reply

Read `status`, then substitute its `sessionId` below:

```sh
octocode-api send --to <instance-id> --session <session-id> \
  --from "external script" --key greeting-1 --require-idle \
  --wait --timeout 120000 -- "Reply with ACK."
```

`--session` checks that the conversation has not changed, including while the host prepares the message. `--require-idle` rejects busy or queued work before dispatch. Without it, the default delivery mode starts a run when idle and steers the next model step when busy. `--mode steer` selects that behavior explicitly; `--mode followUp` queues a later turn when busy. `--` ends flag parsing so message text can begin with a dash.

Without `--wait`, stdout contains the accepted receipt, for example `{"id":"x1","queued":"turn"}`. `queued` can also be `steer` or `followUp`. Acceptance records dispatch to the host; it does not prove that the model read the message or completed the requested task.

With `--wait`, stdout contains the final assistant text when the logical run settles, after queued continuations and retries. This is the run's result; concurrent senders do not receive isolated per-message conversations. The wire response also includes the receipt and, when available, `stopReason`. `--timeout` is in milliseconds: 1,000–3,600,000, default 600,000. The CLI allows an additional ten seconds for the server response.

Messages carry an external sender label and are fenced as untrusted input. The label is not authentication. Reserved user/team identities and live agent IDs cannot be claimed as the sender. Native message hooks and [tool permission policy](permissions.md) still apply.

## Retry without duplicate dispatch

Use a unique `--key` for each intended message. To recover after a lost response, repeat the same message, sender, delivery mode and idle requirement with the **same key**. You may add `--wait` or change the wait timeout. Changing keyed input is rejected; a new key means new work.

Keys are at most 128 characters. The host retains up to 128 keyed receipts for the current conversation in memory and refuses new keys at capacity instead of evicting old receipts. Session replacement, API restart (including `/api off` followed by `/api on`) or process restart loses these receipts. A saved conversation is not a durable idempotency store.

| Result                                                     | Meaning and next step                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution: "not-sent"`                                    | The operation was refused before dispatch. Correct the cause before retrying.                                                                                 |
| Server wait timeout (`-32001`)                             | The message was accepted; work may still be running. Inspect status or wait again with the original key.                                                      |
| `execution: "uncertain"`                                   | The host handoff failed after dispatch. The original key retains the failure and cannot dispatch again. Inspect the conversation before deciding on new work. |
| Connection failure or client timeout without a disposition | Delivery may have happened. Do not infer failure before dispatch from a missing response.                                                                     |

Errors exit nonzero. Protocol errors are JSON on stderr with `error`, `code` and optional `data`; client failures may include `execution`. Other CLI errors are plain text. Preserve this information when integrating. Neither the CLI nor the external-agent adapter automatically replays a possibly executed prompt.

Socket failures include a recognized operating-system error code, for example `API socket transport failed (EPERM)` for a permission refusal or `(ENOENT)` for a missing socket. Raw operating-system messages and paths are omitted. A sandboxed process may discover an instance but still lack permission to connect; use its host's scoped authorization or an explicitly configured callback integration. The error code does not replace the delivery-disposition rules above. See the [Codex integration](acp.md#connect-to-codex) for a tested example and its limits.

## Watch and cancel

Start watching before sending if you need the whole event sequence:

```sh
octocode-api watch --to <instance-id> \
  --types agent.start,message.delta,message,tool.start,tool.end,agent.settled
octocode-api watch --to <instance-id> --since <last-sequence> --top-level
```

Each stdout line is an event with `seq`, `at`, `type` and `data`. The log retains 500 events; `--since` replays retained events after the supplied sequence. The CLI warns on stderr if replay has a gap. Cursors belong to one instance and are not portable across API restarts. `--top-level` filters nested tool events carrying `parentId`.

Default event types are `agent.start`, `agent.end`, `agent.settled`, `message`, `tool.start`, `tool.end`, `external.message` and `compaction`. `message.delta` is opt-in and currently flushes accumulated text at message/run boundaries; it is not a token-by-token stream. A `types` list replaces the default selection.

To request cancellation:

```sh
octocode-api abort --to <instance-id>
```

This acknowledges the abort request, not completed cleanup. Observe `agent.settled` and status afterward. CLI `abort` targets the host's current turn and has no session/key guard. Programmatic callers can pass `expectedSessionId` and the owning message `key` to `turn.abort` to avoid cancelling unrelated work. Cancelling a client wait or closing its connection does not itself abort the host's turn.

## Use alongside ACP

Launch an ACP broker with `OCTOCODE_API=1 octocode --mode acp` when other local processes must reach its workers. Each created ACP session has a native worker and its own discoverable API endpoint. Match `status.sessionId` to the ACP session ID. The ACP client continues to own the broker's stdin and stdout.

API-started work streams output to the connected ACP client. An overlapping ACP `session/prompt` is refused while that work is active; the session remains usable. The ACP client can cancel observed work with `session/cancel`. Direct API sends can steer busy work, while the native external-agent adapter uses an idle-only guarded send.

## Ask a host to connect to another agent

`external` invokes the host's existing external-agent operations and permission checks. Its JSON argument is the **inner action object**, not the native `agent` tool's outer `type`/`input`/`reason` envelope:

```sh
octocode-api external --to <host-instance-id> '{"action":"list"}'
octocode-api external --to <host-instance-id> \
  '{"action":"connect","transport":"octocode","id":"peer","instanceId":"<peer-instance-id>","cwd":"/absolute/peer/workspace"}'
octocode-api external --to <host-instance-id> \
  '{"action":"prompt","id":"peer","text":"Reply with ACK.","timeoutMs":120000}'
octocode-api external --to <host-instance-id> '{"action":"disconnect","id":"peer"}'
```

The peer must have its local API enabled. The adapter verifies its discovered instance, workspace and live conversation identity, and refuses busy peers. Disconnect releases the attachment and cancels work it owns; it does not terminate the peer host. To launch an ACP peer instead, use the `transport: "acp"`, `command`, `args` and `cwd` action from the [ACP guide](acp.md#connect-from-octocode-to-another-agent). Disconnect then stops the owned peer process tree.

## Wire protocol

The local API uses JSON-RPC 2.0, protocol version 1. The [protocol constants](../src/octocode/api/protocol.ts) and [method dispatch](../src/octocode/api/bridge.ts) own its contract. This version number is independent of ACP's version.

| Method                                   | Purpose                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`, `ping`                     | Read API capabilities/instance identity; check liveness                                                                                                          |
| `status`                                 | Read conversation identity, model, activity, pending input and event sequence                                                                                    |
| `message.send`                           | Send `text` with optional `from`, `mode`, `key`, `expectedSessionId`, `requireIdle`, `wait`, `timeoutMs`                                                         |
| `turn.abort`                             | Request cancellation; optional `expectedSessionId` and owning `key` guards                                                                                       |
| `messages.list`                          | Read bounded text history; `limit` defaults to 20, capped at 100; use the returned `earlier.before` as `before`                                                  |
| `events.subscribe`, `events.unsubscribe` | Manage a socket subscription, with optional `since` and `types`                                                                                                  |
| `agents.list`, `agents.tell`             | List the native Team directory or send Team mail with `to` and `text`; Team delivery has its own [acknowledgment contract](../../../docs/AGENT_COMMUNICATION.md) |
| `external.call`                          | Invoke an external-agent action using its inner action object                                                                                                    |

On the Unix socket, each frame is one JSON line. Responses correlate by request ID; events are notifications with `method: "event"` and the event object in `params`. Replay notifications can arrive before the subscription response. That response includes `seq` and `gap`.

HTTP binds to `127.0.0.1`. Use `POST /rpc` for requests, `GET /events` for SSE, and `GET /health` for liveness. Every request requires `Authorization: Bearer <token>` from the private discovery record. Requests with an `Origin` header or a non-loopback Host are refused. SSE accepts `Last-Event-ID` or `since`, plus comma-separated `types`; a `: gap` comment signals missing replay. `events.subscribe` is unavailable over one-shot HTTP RPC.

Discovery records and Unix sockets are owner-only on POSIX systems. Clients must share the host's configured Octocode home to discover it. The API is not a remote network service or a browser API. Requests are bounded to 1 MiB; socket connections and HTTP event streams are each limited to 16. Slow readers are disconnected when queued output exceeds 4 MiB.

## Check an integration

Start an isolated host, then exercise `list` → `status` → guarded `send --wait` → same-key retry → `watch`. Confirm a retry produces no second `agent.start`, and confirm cancellation through a settlement event rather than the abort acknowledgment alone.

From `packages/coding-agent`, these offline tests launch real source CLI workers and cover API/ACP coexistence and command completion:

```sh
yarn vitest run --config vitest.config.ts test/acp-api.test.ts test/acp-command-lifecycle.test.ts
yarn vitest run --config vitest.octocode.config.ts test/octocode/api-cli-subprocess.test.ts test/octocode/api-socket.test.ts
```

See [dated validation](../../../docs/FEATURE_VALIDATION.md) for the scope of completed fixture and live checks.
