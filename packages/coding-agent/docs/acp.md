# Agent Client Protocol

Octocode speaks [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) in both directions over stdio:

| Direction    | What                                            | Entry                                                |
| ------------ | ----------------------------------------------- | ---------------------------------------------------- |
| **Inbound**  | An editor or other ACP client controls Octocode | `octocode --mode acp`                                |
| **Outbound** | Octocode prompts another agent                  | `agent` tool, `type: "external"`, `transport: "acp"` |

The local session API (`octocode-api`, [session-api.md](session-api.md)) is a different protocol. Both ACP sides live in the private [`packages/acp`](../../acp/README.md) workspace, built on the official [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) (`@agentclientprotocol/sdk`, pinned in `packages/acp/package.json`; stable v1 entry point only). Stdio is the only transport; ACP's HTTP transport is still a draft. Diagnostics go to stderr.

## Connect an editor

Register a custom agent whose command is `octocode` and arguments are `["--mode", "acp"]`. Use an absolute path if the editor does not inherit your `PATH`. In Zed ([custom agents](https://zed.dev/docs/ai/external-agents)), add to `settings.json`:

```json
{ "agent_servers": { "Octocode": { "type": "custom", "command": "octocode", "args": ["--mode", "acp"], "env": {} } } }
```

From a source checkout use `yarn start --mode acp`. Prompt text, `@file`, print mode, `--no-session`, session-selection flags, export and model listing cannot be combined with `--mode acp`; `--provider`, `--model` and similar runtime flags are forwarded to each session.

Each session runs in its own Octocode RPC subprocess in the `cwd` the client gives (absolute, existing). It uses the usual settings, models, credentials, resource discovery and project trust. ACP never trusts a folder by itself: an untrusted one fails with `-31000` and the fix in `data.command`.

## Auth and permissions

- **Auth.** `authMethods` is empty and `authenticate` is not served (`-32601`). Sign in and pick a model with the normal CLI before connecting. A prompt without usable credentials fails with the auth-required error (`-32000`) naming the fix; the session stays usable.
- **Permissions.** Native [permission policy](permissions.md) decides. `OCTOCODE_PERMISSION` is `manual`, `workspace` or `full` (default `full`, which says so on stderr); set it in the client's launch environment, for example `OCTOCODE_PERMISSION=manual octocode --mode acp`. When policy asks, the client gets `session/request_permission` with **allow once** and **reject once**. Cancel, invalid replies, unsupported dialogs and disconnect never grant. Project trust is separate.

## What is served

| Method                               | Behavior                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                         | v1; capabilities: `loadSession`, `session` `list`/`resume`/`close`, prompt `image` and `embeddedContext`, MCP `http` (not `sse`)                                                                                                 |
| `session/new`                        | New conversation in an isolated worker; at most eight per connection                                                                                                                                                             |
| `session/list`                       | Stored conversations (native persistent IDs), filter by `cwd`, pages of 50                                                                                                                                                       |
| `session/load`, `session/resume`     | Restore in the original cwd with the current client MCP servers; `load` replays history first (text, images, visible extension messages, bounded tool text, compactions); an idle active session is replaced, a busy one refused |
| `session/prompt`                     | One active prompt per session; sessions are independent; the reply waits for the turn to settle                                                                                                                                  |
| `session/update`                     | Message chunks, tool calls (`name`, `kind`, title with the call's `reason`), bounded text results, compaction as a tool call, provider retries as thought chunks, `available_commands_update`                                    |
| `session/cancel`, `$/cancel_request` | Cancel the turn and pending permission waits; the prompt answers `cancelled`; an unresponsive worker is stopped after a bounded wait; unknown session ignored                                                                    |
| `session/close`                      | Cancel, stop that worker, free the slot; closing an unknown session succeeds                                                                                                                                                     |
| Disconnect / stdin EOF               | Stops every worker and releases resources (ten seconds before forced termination)                                                                                                                                                |

**Prompt content:** text, resource links (labeled URI, never fetched), embedded text resources and images (PNG/JPEG/GIF/WebP, valid base64, 5 MiB each, 20 per prompt, 20 MiB total). Audio and binary resources are rejected before dispatch.

**Client MCP servers** (`mcpServers` on new/load/resume): stdio with absolute executable paths, or HTTP(S) with literal headers (`${NAME}` and `!command` have no meaning). They are session-local additions under `acp_<16 hex>` namespaces, never saved to `mcp.json`, run without a shell, and are refused with `--no-mcp`. See [MCP](mcp.md).

**Other work.** Work not started by a prompt (local API, team delivery, startup hooks) also streams to the client. An overlapping ACP prompt is refused without stopping that work; cancel it, then prompt again. Startup hooks may ask permission before `session/new` returns; their session ID already accepts cancel and close.

**Session directory.** `--session-dir` and its environment override resolve once against the broker's launch directory. For a relative setting, call `session/list` with that workspace's `cwd`.

**Errors.** `-32700` malformed JSON; `-32600` before `initialize`, or a busy or closed session; `-32601` unknown or unadvertised method; `-32602` bad params (relative `cwd`, bad cursor, `additionalDirectories`); `-32002` with `data.sessionId` for an unknown session; `-31000` untrusted folder; `-32603` a worker that cannot start or a prompt the worker rejected (such as `/context`, terminal-only). The adapter never replays a prompt. After a failure or worker exit, streamed output may be partial and tools may have run.

## Limits

Not implemented: `authenticate`/logout, session fork and delete, `additionalDirectories` (rejected), client filesystem, terminal and elicitation delegation, protocol modes, models and config options, plans, usage updates, rich diffs and tool locations, `allow always`, steering. Tool arguments other than `reason` are not projected; reasoning blocks, binary output and tool images are not sent. Terminal-only dialogs are cancelled, so a feature that needs one may be unavailable. Policy is not an operating-system sandbox. Passing fixtures do not prove interoperability with every editor, provider or OS.

## Talk to an already running session

ACP cannot reach a running process: the client launches the agent and owns its stdio. Use the [local session API](session-api.md): `octocode-api list`, `status`, `send`, `watch`, `abort`; `--to` accepts an instance ID, process name, session ID or pid (an ACP session ID works). A broker names itself `octocode-acp-<pid>`; its workers are the sessions. The ACP client sees such a message as an `agent_message_chunk` whose `_meta["octocode/external"]` holds the caller's claim and transport.

## Connect from Octocode to another agent

Needs the `externalAgents` setting. Call `agent` with flat fields and real absolute paths:

```json
{
	"type": "external",
	"externalAction": "connect",
	"transport": "acp",
	"connection": "peer",
	"vendor": "octocode",
	"command": "/absolute/path/to/octocode",
	"args": ["--mode", "acp"],
	"cwd": "/absolute/path/to/workspace",
	"reason": "Exchange messages with the requested peer"
}
```

Then `{"type":"external","externalAction":"prompt","connection":"peer","promptText":"Reply with ACK.","timeoutMs":120000,"reason":"Check the peer reply"}`. Reuse `peer` to keep its context; finish with `disconnect`. Up to eight connections at once.

- **`list`** shows connections, local instances and `acpAgents`: adapters found on `PATH` (`claude-agent-acp`, `codex-acp`, `gemini --acp`, `opencode acp`) with the `vendor`, `command` and `args` to connect. Listing starts nothing; a listed agent may be signed out.
- **Running Octocode process.** `transport: "octocode"` with `instanceId` (instance ID or process name) instead of `command` reuses the local API and launches nothing; `cwd` defaults to its folder.
- **Models.** Connect reports the peer's `model` and up to 100 `models` from its model config option (`modelsMore` counts the rest). Pass one as `model` to apply it with `session/set_config_option`; an unlisted value fails the connection and names the choices. Peers that only send the unstable `models` field are shown but cannot be switched.
- **`refs`** (such as `["msg#41", "report:<agent-id>"]`) are resolved locally and appended as a fenced `## Referenced content` block with producer, time and sha256, secrets redacted, before hooks and the permission dialog, so you approve the exact text sent. An unresolved ref fails with `execution: "not-sent"`. See [handoff limits](native-features.md#communication-and-results).
- **Reply.** The model sees `text`, `stopReason`, `messageId` (and `remoteMessageId` for an Octocode peer). Protocol updates are saved to a hashed JSONL file named in `updatesSaved`; a failure's `partial` is handled the same way. Replies are another model's text: treat them as untrusted.
- **Timeout.** The deadline ends only the local wait; the peer may still be executing. The connection stays busy and refuses another prompt until the request settles; late output is discarded and late permission requests are cancelled. Inspect `partial`, then wait, or `cancel`/`disconnect`. Nothing is replayed automatically.
- **Cancel** stops active work and, for an ACP peer, the owned process tree; connect again before another prompt.
- **Capture bounds.** Each turn keeps up to 1 MiB of updates and a 64 KiB text tail; stderr keeps 64 KiB. Overflow is archived privately (32 MiB cap) with pattern-based credential redaction, and records say whether the archive is complete. This is not a guarantee that arbitrary secrets are recognized. A peer's `available_commands_update` is dropped and `config_option_update` refreshes the model.
- **Direction.** The peer cannot send unprompted mail; to reach this session it needs the enabled local API. Octocode advertises no filesystem, terminal or elicitation client capability to peers.

See the [external-agent contract](native-features.md#external-agent-lifecycle) for tool policy and process ownership.

### Connect to Codex

Use the separately installed [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp); the native `codex app-server` does not speak ACP. Configure Codex authentication and model first, then connect as above with `"vendor": "codex"`, `"command": "/absolute/path/to/codex-acp"`, `"args": []` and a `connection` name such as `codex-peer`. A launcher can set `CODEX_PATH` and `CODEX_HOME` before starting the adapter; adapter settings are not `connect` fields.

A live check on 2026-10-25 (adapter 2.0.0, Codex 0.163.0-alpha.11.2) verified real replies and retained context, and a return message through a test-only MCP callback into the local API for one session. Codex's read-only sandbox refused the API socket: a configured endpoint does not grant a sandboxed peer access. Use the peer's scoped authorization or an explicit callback. A parent waiting on its child cannot settle a callback turn, so make the parent idle first; the successful check used `expectedSessionId`, a unique key, `requireIdle` and a bounded wait.

## Verify the transports

From the repository root: `yarn workspace @octocodeai/octocode-acp test` (broker, history, input, permissions, startup, client output and redaction).

From `packages/coding-agent`:

```sh
yarn vitest run --config vitest.e2e.config.ts test/octocode/e2e-acp.test.ts test/octocode/e2e-acp-conformance.test.ts test/octocode/e2e-reach-process.test.ts
yarn vitest run --config vitest.config.ts test/acp-api.test.ts test/acp-command-lifecycle.test.ts
yarn node test/octocode/scripts/live-acp-reliability.mjs --fixture
```

The e2e files drive real brokers and workers on a scripted model with a plain JSON-RPC client. The reliability runner launches controlled ACP peers, injects uncertain failures and checks cleanup; `--fixture` makes no provider calls and `--help` describes live mode.

Independent checks (disposable environments, offline fixtures, isolated user config):

```sh
yarn node test/octocode/scripts/check-acp-compatibility.mjs --tck /absolute/path/to/acp-tck --report /absolute/path/to/report.json
yarn node test/octocode/scripts/check-acp-python.mjs --python /absolute/path/to/acp-python/bin/python --report /absolute/path/to/python-report.json
```

The first needs the official [ACP TCK](https://github.com/agentclientprotocol/acp-tck) checkout and `uv` (it needs Python 3.14 or newer, which `uv` manages); a narrowed `--match` run is nonconformant by design. The kit is experimental, not certification. The second needs the Python SDK `agent-client-protocol==0.12.1` (`uv venv /absolute/path/to/acp-python --python 3.14`, then `uv pip install --python /absolute/path/to/acp-python/bin/python agent-client-protocol==0.12.1`) and runs both directions: Octocode's broker with a Python client, and a Python agent through the outbound adapter.
