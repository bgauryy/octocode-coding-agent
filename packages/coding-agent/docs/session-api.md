# Local session API

Use `octocode-api` to send messages to a running Octocode host, read its status, watch events, request cancellation and read which agents started and ended (`events`). Every top-level session (terminal, print, RPC, ACP worker) serves this API on an owner-only Unix socket, so other processes of the same user can reach it with no setup; subagents do not. It is separate from [Agent Client Protocol](acp.md): an ACP client launches an agent process; this API attaches to an already running host.

## Start and discover

From the repository root, start a terminal session:

```sh
yarn start
```

In a second terminal in the same checkout:

```sh
yarn node packages/coding-agent/src/octocode/api/cli.ts list
yarn node packages/coding-agent/src/octocode/api/cli.ts status --to <instance-id>
```

`list` prints one line per instance: instance ID, process name, pid, `idle`, `busy` or `not answering`, session ID and working directory. A record whose socket refuses the connection has nothing behind it, whatever now holds its pid, and `list` removes it. Replace `<instance-id>` with an ID from `list`. Installed builds use `octocode-api` instead of `yarn node packages/coding-agent/src/octocode/api/cli.ts`. The commands below use that installed name.

`/api` shows status inside an interactive session. `/api on` starts the API, `/api on http` also enables loopback HTTP on an available port, and `/api off` stops it; either choice holds for that process across `/new` and `/resume`. The global `sessionApi` setting (`false`) keeps new sessions from starting it. A session whose API cannot start warns and carries on. Subagents do not expose their own API.

The Unix socket is mode 0600 in a mode 0700 folder, bound under a restrictive umask, so only the owning user reaches it. It sits beside its record under `<Octocode home>/api`, unless that path would pass 100 bytes (a deep home); then it goes in a private folder in the temp directory, `octocode-<uid>-<pid>-XXXXXX`. A session removes its own on exit. A killed one cannot, so each start with the API on removes such folders whose owner pid is gone and whose socket refuses a connection, whichever home they came from; a live session's folder stays. Loopback HTTP stays opt-in: any local program can open a TCP port, of any user, and only the bearer token stands in its way. `OCTOCODE_API_HTTP` adds it on the port it names (0 picks an available one, up to 65535), and `/api on http` does the same. Windows has no owner-only socket here, so a Windows session starts no API unless `OCTOCODE_API_HTTP` is set or you run `/api on`, which uses HTTP. The HTTP server drops a request whose headers or body take longer than 10 seconds and accepts at most 64 connections at once (`API_HTTP_LIMITS` in `src/octocode/api/server.ts`). See [environment variables](environment-variables.md) and the [configuration map](../../../CONFIGURATIONS.md) for configuration and discovery storage.

An **instance ID** (`oc-1a2b3c`) identifies a running API endpoint. `status.sessionId` identifies its current conversation, and a process is named `octocode-<role>-<last 8 characters of the session ID>` in `ps` and `/processes`. `--to` takes any of them: the instance ID, the process name (`octocode-main-c0ea9f3e`), the id `/processes` shows, the session ID or the pid. `/agents external connect octocode` and the `agent` tool's `instanceId` take the same, and a session's model reaches another by `agent` type `message` to its exact name, instance ID or session ID ([the protocol](native-features.md#communication-and-results)). A name no running instance has, or that several have, is an error listing what would work. A session switch (`/new`, `/resume`) starts a new endpoint with a new instance ID and name. Prefer explicit `--to` in scripts; if omitted, the CLI selects the only instance or the unique instance in the current directory and rejects ambiguity. `send` refuses the caller's own session: its run could never answer a call its own tool is waiting on.

## Send and receive a reply

Read `status`, then substitute its `sessionId` below:

```sh
octocode-api send --to <instance-id> --session <session-id> \
  --from "external script" --key greeting-1 --require-idle \
  --wait --timeout 120000 -- "Reply with ACK."
```

`--session` checks that the conversation has not changed, including while the host prepares the message. `--require-idle` rejects busy or queued work before dispatch. Without it, the default delivery mode starts a run when idle and steers the next model step when busy. `--mode steer` selects that behavior explicitly; `--mode followUp` queues a later turn when busy. `--` ends flag parsing so message text can begin with a dash.

Without `--wait`, stdout contains the accepted receipt, for example `{"id":"x1","queued":"turn"}`. `queued` can also be `steer` or `followUp`. Acceptance records dispatch to the host; it does not prove that the model read the message or completed the requested task.

With `--wait`, stdout contains the final assistant text when the logical run settles, after queued continuations and retries. This is the run's result; concurrent senders do not receive isolated per-message conversations. The wire response also includes the receipt and, when available, `stopReason` and `errorMessage`. When the run did not succeed (`stopReason` is anything but `stop` or `toolUse`, so `error`, `aborted` or `length`), `--wait` exits `1`, leaves stdout empty and writes that JSON result to stderr. `--timeout` is in milliseconds: 1,000–3,600,000, default 600,000. The CLI allows an additional ten seconds for the server response.

A message is subject to the receiving session's [permission mode](permissions.md#external-messages). By default (`sessionApiTurnPermission: "session"`) a session in `full` takes it unasked, whether idle or working, and the turn runs in `full`, audited, so a remote agent never waits on a prompt; `workspace` and `manual` sessions ask as usual. Setting `sessionApiTurnPermission` to `"workspace"` holds API-started turns and steering messages to `workspace` even in a `full` session; see [Turns an API client starts](#turns-an-api-client-starts).

Messages carry an external sender label and are fenced as untrusted input. The label is not authentication. Reserved user/team identities and live agent IDs cannot be claimed as the sender. Native message hooks and [tool permission policy](permissions.md) still apply.

## What the session sees

A message arrives marked as external. The model reads a header built by the receiving process ([template](../src/octocode/instructions/notices/mail/external-message.md)): another process on this machine sent it, not the user; what the transport proves (over the socket, a program running as this OS user; over HTTP, a program holding the token); what the caller says it is, each value quoted; and that it may state facts and make requests but never grants authority, approval or permission. The sender's text follows inside the [untrusted-text fence](../src/octocode/shared/fence.ts), whose random marker the sender cannot know, so the text cannot forge the header or close the fence. A [footer](../src/octocode/instructions/notices/mail/external-reply.md) says what the reader can do: answer, when the caller used `--wait`; use `agent` type `message` to the caller's process name, when the caller named a running instance.

**Nothing about the caller is verified.** A Unix socket does not say who is on the other end, and whatever a process could check, another process of the same user could read and repeat. So `--from` and the caller fields (`name`, `instanceId`, `pid`, `cwd`) are claims, and the text says "says it is". `octocode-api` fills them in: from a session's shell, that session's name, instance ID, pid and folder; from any other program, its pid and folder. Names that would pass for the user or a live agent are refused.

The terminal draws each one as `✉ external`, with the claimed caller, and the text is sanitized and collapsed. RPC `message_end` carries the same facts at `details.external`, ACP `agent_message_chunk` at `_meta["octocode/external"]`, and the API's `external.message` event at `caller`, `callerVerified: false` and `transport`. The `octocode-external` entry the session keeps for each message carries the same `caller` and `callerVerified: false`, and `turnPermission: "workspace"` when the message started a turn held to that mode, so a review reads the name as what the sender said and not as an identity.

## Turns an API client starts

Any process of this OS user can reach the socket, and the caller's name is a claim. By default an API-started turn follows the session's own mode, so a session in `full` runs it in `full` (audited). With `sessionApiTurnPermission: "workspace"`, a turn started through the API does not get a session's `full` mode. Then, when a message arrives while the session is idle:

- Admission (the `message.external` class) is judged in the stricter of the session's mode and `workspace`. A session in `full` asks its user, or, with nobody to ask (print mode, an RPC or ACP worker without a dialog), refuses with `execution: "not-sent"` and a message naming the setting below.
- The turn's tool calls are judged in the same mode until the session settles (`agent_settled`, so retries and queued continuations stay held): calls `workspace` asks about, such as a file change outside the repository or a destructive shell command, ask the user and are refused when nobody can answer, like any other ask. Subagents started during the turn inherit that mode.
- A session already in `manual` stays in `manual`; the ceiling only tightens, and neither the footer chip nor the user's mode choice changes. The audit log records the calls under the mode that judged them.
- A message to a session that is working (`steer`, `followUp`) is held too: its admission is judged as above, and once admitted the running turn, a user turn in `full` included, runs under the ceiling until the session settles. Timing a message to a running turn never yields more than `workspace`.

The global setting `sessionApiTurnPermission` chooses: `"session"` (default) follows the session's mode, where a session in `full` takes the message unasked and runs the turn in `full`; `"workspace"` holds API-started turns as above, and also caps the session for the length of an `external.call` and makes an `agents.tell` message ask (or be refused) before it is admitted; the recipient's turn runs under its own session's mode. Any other value follows the session's mode. A project settings file cannot change it. It is read for each message, so a change applies to the next one. Prefer `OCTOCODE_PERMISSION=manual` or `workspace` over `"session"` where other programs run as the same user.

Tool permissions otherwise do not change. An external message reaches the model; it is not a reply to a dialog. A pending permission dialog or `askUser` question waits for the terminal or RPC client that owns it, and a session in `manual` mode stays manual. A message is not a slash command either: `/permissions full` in one is just text. See [the security notes](#who-can-reach-a-session) for what this does and does not protect.

## What the sender gets

| The receiving session                                                                      | `send` without `--wait`                                                                                                                 | `send --wait`                                          | `agent` type `message`                                             |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Takes it (a `full` session unless `sessionApiTurnPermission` is `"workspace"`, or a grant) | `queued`: `turn`, `steer` or `followUp`                                                                                                 | The run's result                                       | "Sent to `<name>`"                                                 |
| Asks its user                                                                              | At once, `queued: "waiting-for-user"` and a `key` (yours, or one given now); repeating the send with that `--key` waits for the outcome | Waits within `--timeout`, which also closes the dialog | At once, "Waiting for `<name>`'s user"; told later only if refused |
| Its user denies                                                                            | The retry fails with the refusal                                                                                                        | Exit `1`, the refusal on stderr                        | A notice in the sender's session, which starts a turn              |
| Has nobody to ask                                                                          | Exit `1`, the refusal on stderr                                                                                                         | The same                                               | The tool call fails with the refusal                               |

A refusal names the session and what its user can do, with `execution: "not-sent"`. The same key repeats it; only a new key asks again. No deadline applies beyond the sender's `--timeout`; a sender's `agent` call allows the API's maximum, one hour.

## Retry without duplicate dispatch

Use a unique `--key` for each intended message. To recover after a lost response, repeat the same message, sender, delivery mode and idle requirement with the **same key**. You may add `--wait` or change the wait timeout. Changing keyed input is rejected; a new key means new work.

Keys are at most 128 characters. The host retains up to 128 keyed receipts for the current conversation in memory and refuses new keys at capacity instead of evicting old receipts. Session replacement, API restart (including `/api off` followed by `/api on`) or process restart loses these receipts. A saved conversation is not a durable idempotency store.

| Result                                                     | Meaning and next step                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution: "not-sent"`                                    | The operation was refused before dispatch. Correct the cause before retrying.                                                                                 |
| Server wait timeout (`-32001`)                             | The message was accepted; work may still be running. Inspect status or wait again with the original key.                                                      |
| `execution: "uncertain"`                                   | The host handoff failed after dispatch. The original key retains the failure and cannot dispatch again. Inspect the conversation before deciding on new work. |
| Connection failure or client timeout without a disposition | Delivery may have happened. Do not infer failure before dispatch from a missing response.                                                                     |

Errors exit nonzero, including a `--wait` whose run failed. Protocol errors are JSON on stderr with `error`, `code` and optional `data`; client failures may include `execution`. Other CLI errors are plain text. Preserve this information when integrating. Neither the CLI nor the external-agent adapter automatically replays a possibly executed prompt.

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

## Watch agents come and go

`events` reads the agent lifecycle of this directory's workspace from the agent database, so it needs no running session and no `--to`. Each agent that joins is an `on`, a change to its record is a `state`, and the end of its row is an `off` with the reason (`completed`, `failed`, `stopped-user`, `stopped-parent`, `parent-gone`, `crashed` or `left`) and its final numbers.

```sh
octocode-api events --since 0
octocode-api events --since <last-seq> --json
```

Options: `--since <seq>` (default 0) shows events after that sequence; `--limit <n>` (1-1000, default 200) caps one page, oldest first; `--json` prints one object, `{"since", "last", "events": [...]}`. Text output has one tab-separated line per event, then `last seq: <n>`:

```text
4	2026-11-04T23:13:54.297Z	on   	glowing-turtle	general	parent=spry-coral
7	2026-11-04T23:13:54.437Z	off  	glowing-turtle	general	parent=spry-coral	reason=completed	toolCalls=0 input=100 cacheRead=0 output=5 cost=0.000105
8	2026-11-04T23:13:54.622Z	off  	spry-coral	main	reason=left	toolCalls=1 input=100 cacheRead=0 output=5 cost=0.000105
last seq: 8
```

Poll by passing the last sequence back as `--since`; a call with nothing new prints no events and the same `last`. Sequences have gaps (other event kinds and workspaces share the counter), and `last` stays at `--since` when a page is empty. A `--limit` page that is full means more may follow: call again with its `last`. Each event has `seq`, `time`, `event`, `agent`, and when known `role`, `parent`, `session`, `state`, `changes`, `reason`, `detail`, `outcome`, `backlogItem` and, on `off`, `stats`. A directory Octocode never ran in, or a missing database, has no events: the command says so on stderr, exits 0 and creates nothing. `events` only reads, so it is not subject to the permission rules above.

## Use from Claude Code or Codex

A Claude Code or Codex session reaches Octocode through its shell. [`skill-templates/octocode-api/SKILL.md`](skill-templates/octocode-api/SKILL.md) is a ready-to-copy [Agent Skill](https://agentskills.io) that teaches that host to find sessions (`list`), send (`send`, with the idle-session permission behavior) and watch agents with `events --since`. Copy the folder into that host's skills directory yourself (for example `.claude/skills/` or `.codex/skills/` of a project); Octocode does not install it.

## Use alongside ACP

Each session an ACP broker creates has a native worker and its own discoverable API endpoint, so `--to <ACP session ID>` reaches it. The ACP client continues to own the broker's stdin and stdout.

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

The peer must have its local API enabled. The adapter verifies its discovered instance, workspace and live conversation identity, and refuses busy peers. Disconnect releases the attachment and cancels work it owns; it does not terminate the peer host. To launch an ACP peer instead, use the `transport: "acp"`, `command`, `args` and `cwd` action from the [ACP guide](acp.md#connect-from-octocode-to-another-agent). Disconnect then stops the owned peer process tree. `instanceId` takes the same names as `--to`, and `cwd` defaults to the instance's own folder; a `cwd` that differs is refused.

## Wire protocol

The local API uses JSON-RPC 2.0, protocol version 1. The [protocol constants](../src/octocode/api/protocol.ts) and [method dispatch](../src/octocode/api/bridge.ts) own its contract. This version number is independent of ACP's version.

| Method                                   | Purpose                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`, `ping`                     | Read API capabilities/instance identity; check liveness                                                                                                                  |
| `status`                                 | Read conversation identity, model, activity, pending input and event sequence                                                                                            |
| `message.send`                           | Send `text` with optional `from`, `caller` (`name`, `instanceId`, `pid`, `cwd`), `mode`, `key`, `expectedSessionId`, `requireIdle`, `replyRequired`, `wait`, `timeoutMs` |
| `turn.abort`                             | Request cancellation; optional `expectedSessionId` and owning `key` guards                                                                                               |
| `messages.list`                          | Read bounded text history; `limit` defaults to 20, capped at 100; use the returned `earlier.before` as `before`                                                          |
| `events.subscribe`, `events.unsubscribe` | Manage a socket subscription, with optional `since` and `types`                                                                                                          |
| `agents.list`, `agents.tell`             | List the native Team directory or send Team mail with `to` and `text`; Team delivery has its own [acknowledgment contract](../../../docs/AGENT_COMMUNICATION.md)         |
| `external.call`                          | Invoke an external-agent action using its inner action object                                                                                                            |

On the Unix socket, each frame is one JSON line. Responses correlate by request ID; events are notifications with `method: "event"` and the event object in `params`. Replay notifications can arrive before the subscription response. That response includes `seq` and `gap`.

HTTP binds to `127.0.0.1`. Use `POST /rpc` for requests, `GET /events` for SSE, and `GET /health` for liveness. Every request requires `Authorization: Bearer <token>` from the private discovery record. Requests with an `Origin` header or a non-loopback Host are refused. SSE accepts `Last-Event-ID` or `since`, plus comma-separated `types`; a `: gap` comment signals missing replay. `events.subscribe` is unavailable over one-shot HTTP RPC.

Discovery records and Unix sockets are owner-only on POSIX systems. Clients must share the host's configured Octocode home to discover it. The API is not a remote network service or a browser API. Requests are bounded to 1 MiB; socket connections and HTTP event streams are each limited to 16. Slow readers are disconnected when queued output exceeds 4 MiB.

## Who can reach a session

- **Who:** any process running as the same OS user, including ones you did not start: a build script, a dependency's install step, a tool an agent runs. Another OS user cannot: the socket is mode 0600 in a mode 0700 folder. Root can. A sandbox that denies the socket's path also stops it; one that does not (a same-user process with filesystem access) reaches it.
- **What it can do:** read status, history and the event stream (assistant text, tool names and hints); start or steer a turn, which spends model budget (it asks the session's user, unless the session is in `full` and `sessionApiTurnPermission` is not `"workspace"`); abort a turn; call `external.call`, which can start an ACP agent subject to the session's permission mode. A turn the API starts runs under the session's mode by default, so in `full` its tools run without asking (audited); `sessionApiTurnPermission: "workspace"` holds it to `workspace`, which still runs shell commands and file changes in the repository without asking. Either way a message the model acts on runs tools with this user's rights. The marker and the fence tell the model not to treat the message as authority, which lowers that risk and does not remove it. Use `manual` or `workspace` where it matters.
- **What it cannot do:** answer a dialog, approve a [worktree merge](permissions.md#worktree-merges), change the permission mode, run a slash command, or claim to be the user or a live agent.
- **Off:** `sessionApi: false`, or `/api off` for one process.

## Check an integration

Start a host with an isolated `HOME`, then exercise `list` → `status` → guarded `send --wait` → same-key retry → `watch`. Confirm a retry produces no second `agent.start`, and confirm cancellation through a settlement event rather than the abort acknowledgment alone.

From `packages/coding-agent`, these offline tests launch real source CLI workers and cover API/ACP coexistence and command completion:

```sh
yarn vitest run --config vitest.config.ts test/acp-api.test.ts test/acp-command-lifecycle.test.ts
yarn vitest run --config vitest.octocode.config.ts test/octocode/api-cli-subprocess.test.ts test/octocode/api-socket.test.ts test/octocode/api-events.test.ts
yarn vitest run --config vitest.e2e.config.ts test/octocode/e2e-reach-process.test.ts test/octocode/e2e-api-events.test.ts
```
