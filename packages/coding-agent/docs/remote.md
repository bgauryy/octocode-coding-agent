# Remote access

`/remote` lets another device reach this machine's Octocode: every session the user-level web daemon knows, with the
ones blocked on an approval or a question first, their live view, the task board and saved reports. An approval or a
question a run is blocked on can be answered from the remote page (see [native features](native-features.md#web-workspace)).

Remote access is built on the [user-level web daemon](../../../CONFIGURATIONS.md): sessions started with
`OCTOCODE_WEB_DAEMON=1` attach to it, and `/remote` publishes that daemon. Without the flag `/remote` says so and
publishes nothing.

## Commands

| Command          | Effect                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `/remote`        | Publish a control link: the page's full surface, including commands and answers to dialogs.      |
| `/remote view`   | Publish a view-only link: it follows every session and sends nothing.                            |
| `/remote status` | The links published since the daemon started and, with a relay, its connection and device count. |
| `/remote stop`   | Stop publishing. View links stop working at once; control links work until the daemon exits.     |

Each published link is printed with what it allows and, in a terminal, a QR code to scan. The capability (a token or a
key) sits after `#` in the link, which browsers never send to a server.

For scripts and other agents, `octocode remote list [--json]` prints the sessions the daemon reaches with `busy` and
`needsYou` per session plus the published links; `octocode remote link [view] [--relay <url>] [--no-qr]` publishes a
link and `octocode remote stop` stops publishing. These need a running daemon and never start one.

## Transports

`remote.transport` chooses how the other device reaches the daemon.

**`ssh`** (default) runs nothing. The daemon keeps listening on loopback; the printed link is its own page, and the
other device reaches it through a port forward the user runs there first, for example
`ssh -N -L 41234:127.0.0.1:41234 user@host`. The local port must equal the daemon's port, because the daemon accepts
only its own `127.0.0.1:<port>` as the `Host` header. This path needs no third party and no new listener; it suits a
laptop or any device with an SSH client.

**`relay`** makes the daemon dial `remote.relayUrl` (`ws://` or `wss://`) with one outbound WebSocket per published
access level and publish end-to-end sealed frames through it. The link is the relay's page address with the key after
`#`; the room name at the relay is a hash of the key, so the relay never learns the key and forwards bytes it cannot
read. Frames are AES-256-GCM with a fresh nonce each, the room as associated data, and a sequence number per
direction; a frame that does not verify, or replays an old sequence, ends that device's connection. The daemon adds
its own token when it performs a device's request against its loopback server, so a device never holds a daemon token
and the loopback rules (host, origin, view-only writes, scopes) apply unchanged. The relay server and the page that
speaks this protocol arrive with the next step of the
[remote RFC](../../../.octocode/octocode-rfc-generator/2026-10-29-remote-sessions/RFC.md); until then `relay` links
can be issued and are tested against a relay fixture, but there is no public page to open them with.

A relay is a transport you trust to be up, not one you trust with content. Expose a relay only behind TLS or a private
network.

## Access levels

A **control** link is the page the terminal user sees: it sends prompts, steers, stops runs, and answers the dialog a
run is blocked on. A **view** link reads the same pages and the live stream but every write is refused by the daemon
(`403`, "This link is view-only"), and the page shows no composer or answer buttons because the daemon strips the
session's capabilities from what it streams to a view connection. `/remote stop` replaces the view token, so every
view link issued so far is dead; the control token is the daemon's launch token and lives as long as the daemon.

## Settings

| Setting            | Values                             | Meaning                                                                                                                                                    |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote.transport` | `ssh` (default), `relay`           | How a published link reaches the daemon.                                                                                                                   |
| `remote.relayUrl`  | `ws://…` or `wss://…`              | The relay the daemon dials for `relay` links.                                                                                                              |
| `remote.autoStart` | `off` (default), `view`, `control` | Publish a link of that access when a session starts and print it. A project settings file can set `off` but can never turn it on; the global value stands. |

## Daemon routes

`GET`, `POST` and `DELETE /api/admin/remote` answer the control token only: status (`RemoteStatus`), publish
(`RemotePublish` in, `{ link: RemoteLink }` out) and stop. The session list (`GET /api/sessions`) carries `busy` and
`needsYou` per session, blocked sessions first. Contracts live in
[`packages/contacts/src/daemon.ts`](../../contacts/src/daemon.ts); the daemon side in
[`web-daemon/remote/`](../src/octocode/web-daemon/remote/) and the command in [`remote/`](../src/octocode/remote/).

## Verification

Verified on 2026-10-29 with `yarn vitest run --config vitest.octocode.config.ts` over `test/octocode/remote-*.test.ts`,
`web-daemon-server.test.ts` and `web-daemon-session-state.test.ts`: ssh and relay links, the view token's limits, a
sealed request, stream and replay through a relay fixture, the `/remote` command, auto-start and the `octocode remote`
CLI.
