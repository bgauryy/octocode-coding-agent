# Agent Client Protocol

Run Octocode as an agent for an editor or another [ACP v1 client](https://agentclientprotocol.com/protocol/v1/overview):

```sh
octocode --mode acp
```

The client launches this process, sends newline-delimited JSON-RPC on stdin and reads responses and notifications from stdout. Diagnostics go to stderr. From the repository root, the source equivalent is `yarn start --mode acp`.

This is **inbound ACP**: the client controls Octocode. The native `agent` tool with `type: "external"` and `transport: "acp"` is **outbound ACP**: Octocode connects to another agent. `/api` and `octocode-api` expose the separate local session API. These interfaces use different protocols.

## Launch and credentials

Configure the client's executable as `octocode` and its argument list as `["--mode", "acp"]`. Use the installed executable's absolute path if the client does not inherit your shell's `PATH`. The client supplies an absolute, existing session directory in `session/new.cwd`; each session runs in its own Octocode RPC subprocess using that directory.

Workers use the usual settings, model selection, provider credentials, resource discovery and project-trust rules. Ordinary runtime flags such as `--provider` and `--model` are forwarded to each worker. There is no ACP login flow or in-protocol model picker; configure credentials and the model before connecting. ACP does not automatically trust a workspace.

Prompts and session selection arrive over the protocol. Positional prompt text, `@file` arguments, print mode, `--no-session`, CLI continuation/resume/fork/session selection, export and model listing cannot be combined with ACP mode. `octocode --mode acp --help` prints CLI help instead of starting the protocol.

## Supported behavior

| Operation | Behavior |
| --- | --- |
| `initialize` | Reports supported ACP v1 through the pinned TypeScript SDK; a client that cannot use v1 must disconnect |
| `session/new` | New conversation in an isolated native worker; up to eight sessions per connection, including pending creations |
| `session/list` | Lists stored conversations using their native persistent IDs, optionally filtered by cwd and paginated in groups of 50 |
| `session/load` | Restores a stored conversation in its original cwd and replays its textual user and assistant history before replying |
| `session/resume` | Restores the same context without replay; an already active ID must be closed first |
| `session/prompt` | One active prompt per session; different sessions can run independently; response waits for the accepted turn to settle |
| `session/update` | Assistant text and tool lifecycle updates with bounded textual tool results |
| `session/request_permission` | Explicit native permission dialogs with single-use allow/reject choices |
| `session/cancel` | Cancels the turn and pending permission waits; an unresponsive worker is stopped after a bounded wait |
| `session/close` | Cancels ongoing work, stops that session's worker and frees its slot; other sessions continue |
| Disconnect / stdin EOF | Stops the connection's workers and releases owned resources |

The adapter does not replay a prompt after worker failure or timeout. Already streamed output can be partial; a failure does not imply that no tools ran. ACP owns disposable worker process trees. Shutdown allows ten seconds for native cleanup before forced termination; the existing tree helper also bounds its post-kill wait. Detached descendant discovery depends on platform process enumeration. Native transcript IDs identify sessions across connections; only active worker handles belong to the current connection. Load and resume require the transcript's original cwd and use the current client MCP definitions. Load replay projects textual user and assistant blocks and bounded textual tool lifecycle results; images, binary results and compaction markers are not reconstructed for old turns.

The `--session-dir` and session-directory environment overrides are resolved once against the broker's launch directory and shared with workers. For workspace-specific settings that use a relative session directory, request `session/list` with that workspace's `cwd`: an unfiltered list cannot enumerate arbitrary relative directories in other workspaces. Load and resume resolve the configured directory against the requested workspace.

## Prompt content

| Content | Handling |
| --- | --- |
| Text | Passed to the native prompt |
| Resource link | Included as a labeled URI reference; the adapter does not fetch it or delegate a client filesystem read |
| Embedded text resource | URI and supplied text included in the prompt |
| Image | PNG, JPEG, GIF or WebP; padded base64 and matching file signature required; up to 5 MiB each, 20 images and 20 MiB decoded image data per prompt |
| Audio or embedded binary resource | Rejected before dispatch |

Image support also depends on the selected model. The adapter does not project reasoning blocks, binary tool output or images from tool results to the client.

## Permissions

Native [permission policy](permissions.md) remains authoritative. `OCTOCODE_PERMISSION` accepts `manual`, `workspace` or `full`, with `full` as the default. To use manual policy, set `OCTOCODE_PERMISSION=manual` in the client process's launch environment. On POSIX shells:

```sh
OCTOCODE_PERMISSION=manual octocode --mode acp
```

ACP forwards an approval request only when native policy asks and the dialog includes explicit permission metadata. The client receives **allow once** and **reject once** choices. Session-wide grants, denial notes, general questions and terminal-only dialogs are not available through this adapter. Unsupported dialogs are cancelled; invalid replies, cancellation and disconnect never grant approval. Project-resource trust is separate from permission mode.

## Client MCP servers

`session/new`, `session/load` and `session/resume` accept client MCP servers. Stdio commands must be absolute executable paths. Streamable HTTP and legacy SSE servers accept an HTTP(S) URL and literal request headers. Client definitions are session-local additions to the normally configured MCP servers; they are not saved to `mcp.json`. An empty list adds no servers. Experimental ACP-channel transport is unsupported, and a nonempty list cannot be used with `--no-mcp`.

The worker loads a temporary extension that registers these servers through the existing MCP lifecycle. Client names become stable native `acp_<16 hexadecimal characters>` namespaces, with the original name retained in the description. Duplicate names and occupied namespaces are refused rather than substituting another configured server. These registrations use direct tool exposure.

The command and arguments execute without a shell. Client environment and HTTP header values are literal: `${NAME}` and `!command` have no expansion meaning here. The private manifest and launcher files are removed after the worker stops. On POSIX systems their directory is mode 0700 and files are mode 0600. Compiled Bun builds require `node` on `PATH` for the stdio MCP launcher.

Registration is verified during session startup. A successfully registered server may still fail to connect; ordinary MCP connection diagnostics remain in effect. Host MCP configuration and its precedence remain documented in [MCP](mcp.md) and the [configuration map](../../../CONFIGURATIONS.md).

## Current limits

The adapter does not expose session fork/delete, additional workspace roots, client filesystem or terminal delegation, protocol model/mode/configuration changes, steering, slash-command discovery, plans, usage updates or rich diffs. Nonempty `additionalDirectories` are rejected during session creation, load and resume. Close an individual session to free a slot, or disconnect to release all of the connection's sessions.

Generic UI dialogs and terminal custom components are not supported. A native feature that requires one of those interactions may be unavailable through ACP even though its tool is registered. Existing native application policy is not an operating-system sandbox.

The [design RFC](../../../docs/RFC_ACP_EXPOSURE.md) tracks architecture and validation. Offline fixtures do not establish live provider authentication or interoperability with every editor; those require configured integration checks.
