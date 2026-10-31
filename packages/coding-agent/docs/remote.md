# Remote access

`/remote` lets another device reach this machine's Octocode: every session the user-level web daemon knows, with the
ones blocked on an approval or a question first, their live view, the task board and saved reports. An approval or a
question a run is blocked on can be answered from the remote page (see [native features](native-features.md#backlog-view)).

Remote access is built on the [user-level web daemon](../../../CONFIGURATIONS.md): sessions started with
`OCTOCODE_WEB_DAEMON=1` attach to it, and `/remote` publishes that daemon. Without the flag `/remote` says so and
publishes nothing.

## Commands

| Command          | Effect                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `/remote`        | Publish a control link: the page's full surface, including commands and answers to dialogs.      |
| `/remote view`   | Publish a view-only link: it follows every session and sends nothing.                            |
| `/remote status` | The links published since the daemon started (by fingerprint) and, with a relay, its connection. |
| `/remote stop`   | Stop publishing. Every link, view and control, stops working at once.                            |

Each published link is printed once, when it is published, with what it allows and, in a terminal, a QR code to scan.
The capability (a token or a key) sits after `#` in the link, which browsers never send to a server. Listings never
show it: `/remote status`, `GET /api/admin/remote` and `octocode remote list [--json]` name each link by an 8-character
fingerprint (a hash of its token or key) and its access, transport and time of issue.

For scripts and other agents, `octocode remote list [--json]` prints the sessions the daemon reaches with `busy` and
`needsYou` per session plus the published links; `octocode remote link [view] [--relay <url>] [--no-qr]` publishes a
link (printing it in full) and `octocode remote stop` stops publishing. These need a running daemon and never start one.
`octocode remote link` does not read `remote.transport` or `remote.relayUrl`: it publishes an `ssh` link unless
`--relay <url>` is given.

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
read or reuse (see [wire format](#relay-wire-format-version-1)). The daemon adds its own token when it performs a
device's request against its loopback server, so a device never holds a daemon token and the loopback rules (host,
origin, view-only writes, scopes) apply unchanged. The relay server and the page that speaks this protocol arrive with
the next step of the [remote RFC](../../../.octocode/octocode-rfc-generator/2026-10-29-remote-sessions/RFC.md); until
then `relay` links can be issued and are tested against a relay fixture, but there is no public page to open them with.

`remote.relayUrl` may carry a path prefix: `wss://host/octo` is dialed at `wss://host/octo/v1/rooms/<room>/host`, and its
page link is `https://host/octo/`. A query string is dropped from both.

A relay is a transport you trust to be up, not one you trust with content. Expose a relay only behind TLS or a private
network. Use `wss://` for any device but this one: a `ws://` relay's page link is `http://`, and browsers expose
WebCrypto only in a secure context (`https://` or localhost), so such a page cannot open a frame.

### Relay wire format, version 1

Everything below is computable in a browser with WebCrypto (`SHA-256`, `HKDF`, `AES-GCM`); the daemon side is
[`seal.ts`](../src/octocode/web-daemon/remote/seal.ts) and [`protocol.ts`](../src/octocode/web-daemon/remote/protocol.ts).

- **Link key** `K`: 32 random bytes, in the link fragment as `#k=<base64url, no padding, 43 characters>`.
- **Room**: `hex(SHA-256("octocode-remote-room" || K))`, first 32 characters. The daemon connects to
  `<relay>/v1/rooms/<room>/host`, a page to `<relay>/v1/rooms/<room>/peer`.
- **Relay frames** (daemon side, JSON text): `{"type":"peer.open"|"peer.close","peer":"<id>"}` and
  `{"type":"peer.message","peer":"<id>","data":"<text>"}`. The relay chooses peer ids. A page's own socket carries only
  the `data` text, as one WebSocket text message per frame.
- **Wire frames** (`data`; JSON text, `v` must be exactly `1`; anything else, including the old unversioned frames, is
  refused and the daemon closes that peer):
  1. Daemon to page, first, when the relay announces the peer: `{"v":1,"t":"hello","nonce":"<16 random bytes, base64url, 22 characters>"}`.
  2. Page to daemon, once: `{"v":1,"t":"join","nonce":"<page's own 16 random bytes, base64url>"}`. A peer that has not joined
     within 10 seconds is closed; a second `join`, or a sealed frame before `join`, closes the peer.
  3. Then both sides send only `{"v":1,"t":"msg","s":<seq>,"d":"<base64 of ciphertext || 16-byte tag>"}`; `d` uses the
     standard alphabet with padding (the daemon also accepts it unpadded).
- **Key schedule**: for each direction `dir` in `d2p` (daemon to page) and `p2d` (page to daemon),
  `key[dir] = HKDF-SHA256(ikm = K, salt = daemonNonce || pageNonce (32 bytes), info = UTF-8("octocode-remote v1|<room>|<dir>"), length = 32)`.
  The nonces are fresh for each peer connection, so frames of one connection never open under another's keys.
- **Sequence**: each direction counts its `msg` frames from `s = 0`. The receiver accepts exactly the next number; a
  repeat, a gap or a frame from another connection ends the peer.
- **Sealing**: AES-256-GCM with `key[dir]`; IV (12 bytes) = four zero bytes then `s` as a 64-bit big-endian integer;
  additional data = UTF-8(`"octocode-remote v1|<room>|<dir>|<s as decimal>"`); tag 16 bytes. The peer id is chosen by
  the relay and unknown to the page, so it is not bound; the fresh nonces bind a connection instead.
- **Plaintext** of a `msg` is JSON. Page to daemon: `{"kind":"request","id","method":"GET"|"POST","path","body?"}`,
  `{"kind":"stream.open","stream","path","cursor?"}`, `{"kind":"stream.close","stream"}`. Daemon to page: `{"kind":"hello","access","build"}`
  (always `s = 0`; a page that opens it knows the daemon holds `K`), `{"kind":"response","id","status","body"}`,
  `{"kind":"stream.message","stream","data"}`, `{"kind":"stream.end","stream","code"}`. `id` and `stream` match
  `[\w.-]{1,64}`; `access` is `control` or `view`. A request `body` and a response `body` are strings (JSON text, not
  parsed objects); a request with a body is sent as `application/json`. `cursor` is the application-stream cursor
  object; `data` is the stream's text message.
- **Paths**: `path` is an origin-form request target: a single `/` followed by at most 2048 units, each an RFC 3986
  character (unreserved, sub-delims, `:`, `@`, `/`, `?`) or a percent-encoded octet counted as one unit. Any other target is answered `400`
  (`stream.end` code `1008` for a stream) and the peer carries on.
- **Limits**: 16 peers per room, 16 requests and 8 streams in flight per peer, 16 Mi characters of `d` per frame
  (about 12 MiB of ciphertext), 256 KiB request body. A request gets `502` after 15 seconds or when its response
  passes 8 MiB; a stream message may be up to 4 MiB. Streams share the daemon's 64 tabs with local pages, so a stream
  opened when they are full ends with code `1013`.

A new version changes `v`, the `info` and additional-data prefix, and is refused by older daemons.

## Access levels

A **control** link is the page the terminal user sees: it sends prompts, steers, stops runs, and answers the dialog a
run is blocked on. A **view** link reads the same pages and the live stream but every write is refused by the daemon
(`403`, "This link is view-only"), and the page shows no composer or answer buttons because the daemon strips the
session's capabilities from what it streams to a view connection. A view link is machine-wide: it reads every attached
session of every repository (full transcripts), the board, reports and `/api/config` (provider source kinds and
environment variable names, never secret values). Share it as you would share the screen.

The daemon has three tokens. The **launch token** is the local browser's and the CLI's: the page's full surface and
every `/api/admin/*` route (drain, publishing, stopping); it is never put in a link. The **remote control token** is
what SSH control links and relay control rooms carry: everything the page does, but every `/api/admin/*` route answers
`403`, so a phone cannot shut the daemon down or publish more links. The **view token** reads. `/remote stop` replaces
both the remote control and the view token, closes the relay rooms, closes tabs opened through a link and forgets the
links: every published link is dead, and the local browser keeps working.

An idle daemon exits ten minutes after its last tab, attached session or relay device; a device connected through a
relay counts as use, a published link nobody has joined does not, so unused links die with an idle daemon.

## Settings

| Setting            | Values                             | Meaning                                                                                                                                                    |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote.transport` | `ssh` (default), `relay`           | How a published link reaches the daemon.                                                                                                                   |
| `remote.relayUrl`  | `ws://…` or `wss://…`              | The relay the daemon dials for `relay` links.                                                                                                              |
| `remote.autoStart` | `off` (default), `view`, `control` | Publish a link of that access when a session starts and print it. A project settings file can set `off` but can never turn it on; the global value stands. |

## Daemon routes

`GET`, `POST` and `DELETE /api/admin/remote` answer the launch token only (like all `/api/admin/*` routes): status
(`RemoteStatus`, fingerprints only), publish (`RemotePublish` in, `{ link: RemoteLink }` out, the only reply that
carries a capability) and stop. The session list (`GET /api/sessions`) carries `busy` and
`needsYou` per session, blocked sessions first. Contracts live in
[`packages/contracts/src/daemon.ts`](../../contracts/src/daemon.ts); the daemon side in
[`web-daemon/remote/`](../src/octocode/web-daemon/remote/) and the command in [`remote/`](../src/octocode/remote/).

## Verification

Verified on 2026-10-30 with `yarn vitest run --config vitest.octocode.config.ts` over `test/octocode/remote-*.test.ts`
and `web-daemon-*.test.ts`: ssh and relay links, the three tokens and the admin refusals, status without capabilities,
the handshake with a WebCrypto page (`remote-page-fixture.ts`), replay into a new peer, invalid paths, a relay path
prefix, relay-peer keep-alive, the `/remote` command, auto-start and the `octocode remote` CLI.
