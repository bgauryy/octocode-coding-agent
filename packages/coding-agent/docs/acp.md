# Agent Client Protocol

Run Octocode as an agent for an editor or another [ACP v1 client](https://agentclientprotocol.com/protocol/v1/overview):

```sh
octocode --mode acp
```

The client launches this process, sends newline-delimited JSON-RPC on stdin and reads responses and notifications from stdout. Diagnostics go to stderr. From the repository root, the source equivalent is `yarn start --mode acp`.

This is **inbound ACP**: the client controls Octocode. The native `agent` tool with `type: "external"` and `transport: "acp"` is **outbound ACP**: Octocode connects to another agent. `/api` and `octocode-api` expose the separate local session API. These interfaces use different protocols.

Both ACP implementations live in the private [`packages/acp` workspace](../../acp/README.md), compiled into this package's `dist/acp/`. The CLI and native tool contracts are unchanged. The workspace README owns implementation boundaries and package tests; this guide owns the user-facing protocol contract.

## Protocol and library compatibility

This adapter targets **ACP v1 over stdio**. The official [protocol index](https://agentclientprotocol.com/get-started/introduction) identifies v1 as the current version and v2 as a draft. The [transport specification](https://agentclientprotocol.com/protocol/v1/transports) still describes Streamable HTTP as a draft. Octocode's local HTTP API is a different protocol; MCP HTTP/SSE capability flags do not advertise an ACP HTTP endpoint.

Both adapters use the official [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript), pinned to `@agentclientprotocol/sdk` **2.0.2**, with typed `agent()`/`client()` handlers, `methods` and `ndJsonStream`. The default import supplies stable v1 schemas and validation. SDK 2 does not switch the wire protocol to ACP v2; see its [migration guide](https://github.com/agentclientprotocol/typescript-sdk/blob/v2.0.2/MIGRATION_STABLE_UNSTABLE.md). The integration does not use legacy connection classes or the unstable/v2 entry points.

| Surface | Advertised and implemented behavior |
| --- | --- |
| Base protocol | Initialize, new session, text/resource-link prompts, ordered updates, permission requests and prompt cancellation |
| Session capabilities | `loadSession: true`; `sessionCapabilities` includes `list`, `resume` and `close` |
| Prompt capabilities | `image` and `embeddedContext`; supported formats and bounds are listed below |
| MCP capabilities | Stdio plus `http` and `sse` for client-supplied MCP servers |
| Authentication | Host-configured credentials; `authMethods: []`, no protocol authentication/logout flow |
| Client filesystem, terminals and elicitation | Not requested by the agent; native host tools and permission policy own execution |
| Optional mode/configuration, deletion, fork and remote ACP | Not exposed; see current limits below |

Capability negotiation is part of compatibility: clients must check the response before using optional methods. Missing capabilities do not mean support. Octocode's outbound client advertises no optional client filesystem, terminal or elicitation capabilities and checks `loadSession` before restoring a peer. The [initialization specification](https://agentclientprotocol.com/protocol/v1/initialization) owns these rules.

## Launch and credentials

Configure the client's executable as `octocode` and its argument list as `["--mode", "acp"]`. Use the installed executable's absolute path if the client does not inherit your shell's `PATH`. The client supplies an absolute, existing session directory in `session/new.cwd`; each session runs in its own Octocode RPC subprocess using that directory.

Workers use the usual settings, model selection, provider credentials, resource discovery and project-trust rules. Ordinary runtime flags such as `--provider` and `--model` are forwarded to each worker. There is no ACP login flow or in-protocol model picker; configure credentials and the model before connecting. ACP does not automatically trust a workspace.

ACP owns conversation selection. Extension commands in an ACP worker cannot create, switch or fork its native conversation. An uncaught command refusal fails the ACP prompt and leaves the conversation available for subsequent prompts. Use `session/new`, `session/load` or `session/resume` from the client; protocol session forking remains unsupported. Ordinary RPC extension controls remain available outside ACP-owned workers.

Prompts and session selection arrive over the protocol. Positional prompt text, `@file` arguments, print mode, `--no-session`, CLI continuation/resume/fork/session selection, export and model listing cannot be combined with ACP mode. `octocode --mode acp --help` prints CLI help instead of starting the protocol.

## Supported behavior

| Operation                    | Behavior                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `initialize`                 | Reports supported ACP v1 through the pinned TypeScript SDK; a client that cannot use v1 must disconnect                 |
| `session/new`                | New conversation in an isolated native worker; up to eight sessions per connection, including pending creations         |
| `session/list`               | Lists stored conversations using their native persistent IDs, optionally filtered by cwd and paginated in groups of 50  |
| `session/load`               | Restores a stored conversation in its original cwd and replays supported history before replying                        |
| `session/resume`             | Restores the same context without replay; an idle session may be resumed on the same connection                                     |
| `session/prompt`             | One active prompt per session; different sessions can run independently; response waits for the accepted turn to settle |
| `session/update`             | Assistant text and tool lifecycle updates with bounded textual tool results                                             |
| `session/request_permission` | Explicit native permission dialogs with single-use allow/reject choices                                                 |
| `session/cancel`             | Cancels the turn and pending permission waits; an unresponsive worker is stopped after a bounded wait                   |
| `session/close`              | Cancels ongoing work, stops that session's worker and frees its slot; other sessions continue                           |
| Disconnect / stdin EOF / output failure | Stops the connection's workers and releases owned resources before the broker exits                           |

The adapter does not replay a prompt after worker failure or timeout. Already streamed output can be partial; a failure does not imply that no tools ran. ACP owns disposable worker process trees. Shutdown allows ten seconds for native cleanup before forced termination; the existing tree helper also bounds its post-kill wait. Detached descendant discovery depends on platform process enumeration. Native transcript IDs identify sessions across connections; only active worker handles belong to the current connection. Load and resume require the transcript's original cwd and use the current client MCP definitions. Load replay includes user/assistant text, stored images, visible extension messages (including external API input), and bounded textual tool results. Hidden extension context, reasoning, binary tool results and compaction markers are not projected. Reloading or resuming an idle session on the same connection replaces its worker with the supplied MCP definitions; a busy session is refused without cancelling its work.

Live and restored textual tool results use the same size limit and explicit truncation notice.

A prompt that invokes a command waits for the work that command dispatches, including nested extension messages. A command that starts no work completes immediately. Work started through the local API or native team delivery also streams updates to the connected ACP client. An overlapping ACP prompt is refused without stopping that work or closing the session; the client can cancel the observed work with `session/cancel` and send another prompt after it settles.

Startup-triggered work uses the persistent session ID. A restored worker opens its transcript before running startup hooks; it does not first start a throwaway conversation. Load snapshots the saved history before those hooks run, sends that history first, then releases live startup updates without replaying them twice.

Startup hooks can await native permission replies. The client may receive updates or permission requests before `session/new` or `session/load` completes; their canonical session ID already accepts cancellation and close. Unsupported startup dialogs are cancelled. New ACP prompts are refused until startup finishes, and disconnect also cleans up workers whose startup has not completed.

The `--session-dir` and session-directory environment overrides are resolved once against the broker's launch directory and shared with workers. For workspace-specific settings that use a relative session directory, request `session/list` with that workspace's `cwd`: an unfiltered list cannot enumerate arbitrary relative directories in other workspaces. Load and resume resolve the configured directory against the requested workspace.

## Prompt content

| Content                           | Handling                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text                              | Passed to the native prompt                                                                                                                      |
| Resource link                     | Included as a labeled URI reference; the adapter does not fetch it or delegate a client filesystem read                                          |
| Embedded text resource            | URI and supplied text included in the prompt                                                                                                     |
| Image                             | PNG, JPEG, GIF or WebP; padded base64 and matching file signature required; up to 5 MiB each, 20 images and 20 MiB decoded image data per prompt |
| Audio or embedded binary resource | Rejected before dispatch                                                                                                                         |

Image support also depends on the selected model. The adapter does not project reasoning blocks, binary tool output or images from tool results to the client.

## Permissions

Native [permission policy](permissions.md) remains authoritative. `OCTOCODE_PERMISSION` accepts `manual`, `workspace` or `full`, with `full` as the default. To use manual policy, set `OCTOCODE_PERMISSION=manual` in the client process's launch environment. On POSIX shells:

```sh
OCTOCODE_PERMISSION=manual octocode --mode acp
```

ACP forwards an approval request only when native policy asks and the dialog includes explicit permission metadata. The client receives **allow once** and **reject once** choices. Session-wide grants, denial notes, general questions and terminal-only dialogs are not available through this adapter. Unsupported dialogs are cancelled; invalid replies, cancellation and disconnect never grant approval. Project-resource trust is separate from permission mode.

## Client MCP servers

`session/new`, `session/load` and `session/resume` accept client MCP servers. Stdio commands must be absolute executable paths. Streamable HTTP and legacy SSE servers accept an HTTP(S) URL and literal request headers. Client definitions are session-local additions to the normally configured MCP servers; they are not saved to `mcp.json`. An empty list adds no servers. Experimental ACP-channel transport is unsupported, and a nonempty list cannot be used with `--no-mcp`.

The worker loads a temporary extension that registers these servers through the existing MCP lifecycle. Client definitions explicitly load the shared built-in MCP host even when automatic extensions are disabled; `--no-mcp` still refuses a nonempty client list. Client names become stable native `acp_<16 hexadecimal characters>` namespaces, with the original name retained in the description. Duplicate names and occupied namespaces are refused rather than substituting another configured server. These registrations use direct tool exposure.

The command and arguments execute without a shell. Client environment and HTTP header values are literal: `${NAME}` and `!command` have no expansion meaning here. The private manifest and launcher files are removed after the worker stops. On POSIX systems their directory is mode 0700 and files are mode 0600. Compiled Bun builds require `node` on `PATH` for the stdio MCP launcher.

Registration is verified during session startup. A successfully registered server may still fail to connect; ordinary MCP connection diagnostics remain in effect. Host MCP configuration and its precedence remain documented in [MCP](mcp.md) and the [configuration map](../../../CONFIGURATIONS.md).

## Current limits

For outbound calls (`agent` with `type: "external"` and `transport: "acp"`), each turn retains up to 1 MiB of update data plus a 64 KiB text tail; connection stderr keeps a 64 KiB tail. Overflow is saved through the existing private session artifact lifecycle with credential-pattern redaction, capped at 32 MiB per archive. Truncation records identify the archive, whether it is complete, omitted bytes and write failures. Final stop reasons and uncertain-execution errors remain available even when evidence cannot be archived. These are outbound capture limits, separate from the inbound client's rendering limits.

Credential matching spans text deltas and stderr chunks. The redactor holds unfinished logical lines, including credential introducers that continue over a newline, up to 64 KiB per stream. PEM private-key blocks are redacted through their matching footer or capture end; oversized blocks remain withheld through the footer. Longer unfinished units are omitted until a safe boundary and counted explicitly. Captures track up to eight unfinished text streams with identities bounded to 1,024 UTF-8 bytes. Archived text notifications retain their metadata and point to separate redacted `text_stream` records; readers must use those records to recover retained text. A partial capture, buffered text, redaction omission or write failure makes `archiveComplete` false. This is pattern-based redaction, not a guarantee that arbitrary confidential content will be recognized.

The adapter does not expose session fork/delete, additional workspace roots, client filesystem or terminal delegation, protocol model/mode/configuration changes, steering, slash-command discovery, plans, usage updates or rich diffs. Nonempty `additionalDirectories` are rejected during session creation, load and resume. Close an individual session to free a slot, or disconnect to release all of the connection's sessions.

Generic UI dialogs and terminal custom components are not supported. A native feature that requires one of those interactions may be unavailable through ACP even though its tool is registered. Existing native application policy is not an operating-system sandbox.

The [design RFC](../../../docs/RFC_ACP_EXPOSURE.md) tracks architecture and [dated validation](../../../docs/FEATURE_VALIDATION.md) separates source/fixture checks from live provider checks. A passing fixture suite does not establish interoperability with every editor, provider or operating system.

## Talk to an already running session

Enable the [local session API](session-api.md) with `OCTOCODE_API=1` when a terminal session or an ACP worker must receive messages from other local processes. Use `octocode-api list`, `status`, `send`, `watch` and `abort` to discover it and exchange messages. For ACP workers, match the API's `status.sessionId` to the ACP session ID; the ACP client retains the broker's stdin and stdout.

The API guide owns runnable examples, session guards, idempotency keys, timeouts, event replay and cancellation semantics. API-started work is also visible to a connected ACP client.

## Connect from Octocode to another agent

Use the native `agent` tool with this envelope, replacing the executable and workspace with real absolute paths:

```json
{
	"type": "external",
	"input": {
		"action": "connect",
		"transport": "acp",
		"id": "peer",
		"vendor": "octocode",
		"command": "/absolute/path/to/octocode",
		"args": ["--mode", "acp"],
		"cwd": "/absolute/path/to/workspace"
	},
	"reason": "Exchange messages with the requested peer"
}
```

Then send `agent` input `{"type":"external","input":{"action":"prompt","id":"peer","text":"Reply with ACK.","timeoutMs":120000},"reason":"Check the peer reply"}`. Reuse `peer` for subsequent messages to preserve its context; finish with action `disconnect`. `cancel` stops active work; for an ACP peer it also stops the owned process, so connect again before another prompt. `list` shows connections and discoverable local instances. For an existing Octocode process, connect with `transport: "octocode"` and its exact discovered `instanceId` instead of a command. This reuses the local API and does not launch another process.

An outbound ACP deadline ends the local wait while the peer may still be executing. The connection stays busy and refuses another prompt until that request settles. Interactive running-work warnings still include it before leaving the host session. Late output is discarded and later permission requests are cancelled. Inspect the partial result, then either wait for settlement or explicitly `cancel`/`disconnect`; reconnect after cancellation. A timeout never triggers automatic replay. See the [native external-agent contract](native-features.md#external-agent-lifecycle) for the surrounding tool policy.

An outbound ACP connection returns replies to prompts; it does not deliver unsolicited mail to its parent. To initiate a message independently, an external process uses the parent's enabled local API. ACP and that API are separate protocols with separate lifecycle owners.

### Connect to Codex

Use the separately installed [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp). It translates ACP into [Codex App Server](https://learn.chatgpt.com/docs/app-server) requests; the native `codex app-server` executable does not speak ACP. Configure Codex authentication and model selection before connecting. For the native `agent` tool:

```json
{
	"type": "external",
	"input": {
		"action": "connect",
		"transport": "acp",
		"id": "codex-peer",
		"vendor": "codex",
		"command": "/absolute/path/to/codex-acp",
		"args": [],
		"cwd": "/absolute/path/to/workspace"
	},
	"reason": "Exchange messages with the requested Codex session"
}
```

Send subsequent `prompt` actions to `codex-peer`, then `disconnect` when finished. The adapter normally uses its bundled Codex binary. A launcher can set `CODEX_PATH` to a selected binary and `CODEX_HOME` to its configured home before starting the adapter. Adapter-specific settings belong to that launcher or Codex configuration; they are not Octocode `connect` fields.

The [2026-10-25 live check](../../../docs/FEATURE_VALIDATION.md#real-codex-and-octocodecode-exchange--2026-10-25) verified real model replies and retained context with adapter **2.0.0** and Codex **0.163.0-alpha.11.2**. It also verified a return message through a test-only MCP callback into Octocode's local API. That callback was explicitly configured for one session and message; it is not a built-in Octocode MCP server or unsolicited ACP delivery.

Codex's read-only shell sandbox refused direct access to the local API socket in that check. A configured API endpoint does not grant a sandboxed peer access to it. Use the peer host's supported scoped authorization or an explicitly configured callback integration; do not treat full filesystem access as a communication requirement. When waiting for a parent's reply, ensure that parent is idle: a parent waiting on the child cannot also settle a queued callback turn. The successful check prompted Codex through `external.call` after the parent turn had settled, and the callback used `expectedSessionId`, a unique key, `requireIdle` and a bounded wait.

## Verify the transports

Run the ACP package's broker/client tests from the repository root with `yarn workspace @octocodeai/octocode-acp test`. CLI, RPC and local-API integration tests remain in coding-agent.

From `packages/coding-agent`, the offline reliability runner launches real subprocesses with controlled ACP peers, checks stateful and concurrent conversations, injects uncertain failures and verifies cleanup:

```sh
yarn node test/octocode/scripts/live-acp-reliability.mjs --fixture
yarn vitest run --config vitest.config.ts test/acp-api.test.ts test/acp-command-lifecycle.test.ts
```

`--fixture` makes no provider calls. The runner's `--help` describes the separately configured live mode. The integration tests exercise the source ACP broker and native RPC worker, including API delivery and cancellation on an ACP-owned session. Use the repository's supported Node 24 runtime and installed dependencies.

For an independent protocol check, obtain the official [ACP Test Compatibility Kit](https://github.com/agentclientprotocol/acp-tck) and install `uv`. From `packages/coding-agent`:

```sh
yarn node test/octocode/scripts/check-acp-compatibility.mjs \
  --tck /absolute/path/to/acp-tck --report /absolute/path/to/report.json
```

The runner invokes the checkout's locked Python dependencies, launches the real source CLI with an offline fixture provider, isolates user configuration and credentials, and removes its temporary user directories afterward. The report stays at the requested path. The TCK version used on 2026-10-25 requires Python 3.14 or newer; `uv` manages that runtime. This checks protocol behavior without testing model quality or provider authentication.

`--match <pytest-expression>` narrows a diagnostic run, but omitted mandatory checks produce a non-conformant verdict and nonzero exit even if selected tests pass. Use the full run for the TCK's verdict. The upstream kit is experimental and incomplete; its result is not official certification. See [upstream testing guidance](https://agentclientprotocol.com/libraries/testing) and the [dated local results](../../../docs/FEATURE_VALIDATION.md).

For a separate SDK implementation, install the official [Python SDK](https://agentclientprotocol.com/libraries/python) in a disposable environment, then run the bidirectional check from `packages/coding-agent`:

```sh
uv venv /absolute/path/to/acp-python --python 3.14
uv pip install --python /absolute/path/to/acp-python/bin/python agent-client-protocol==0.12.1
yarn node test/octocode/scripts/check-acp-python.mjs \
  --python /absolute/path/to/acp-python/bin/python \
  --report /absolute/path/to/python-report.json
```

This launches the real Octocode source broker with the Python client, then launches a Python agent through Octocode's outbound adapter. Assertions cover Unicode, ordered replies, stored images, load/resume/list, concurrent sessions, permissions, cancellation, timeout evidence and cleanup. Both directions run with isolated user configuration and an allowlisted environment. The runner records broker, native worker and Python peer PIDs and requires them to exit through their owners' cleanup before fallback termination. It requires that exact Python package version, uses deterministic offline fixtures, and removes its temporary user configuration. It does not install a Python runtime dependency into Octocode or test a live editor/model. The Python environment and requested report remain available after the run.
