# MCP reference

Start with the [short MCP guide](mcp.md) for setup, terminal commands, agent context, and tool exposure. This page covers less common options and behavior.

## Configuration and precedence

All files use a top-level `mcpServers` object. Definitions load from low to high priority:

| Scope             | Read order                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| User              | `~/.pi/mcp.json` → `~/.pi/agent/mcp.json` → `~/.octocode/agent/mcp.json` → `~/.octocode/octocodecode/mcp.json` → `~/.octocode/mcp.json` |
| Trusted workspace | `.pi/mcp.json` → `.mcp.json` → `.agents/mcp.json` → `.octocode/mcp.json`                                                                |

The canonical write targets are `~/.octocode/mcp.json` and `<workspace>/.octocode/mcp.json`. Workspace paths are relative to the session directory and require `/trust` after changes; reload a running session with `/reload`. SDK hosts must pass `projectTrusted: true` to load workspace files. Explicit `OCTOCODE_HOME`, `OCTOCODE_CODING_AGENT_DIR`, or custom SDK agent directories read only their global `mcp.json`. Use `/mcp config` to see resolved paths.

A later full definition replaces an earlier transport without merging credentials. An entry with no `command`, `url`, or `type` changes only `enabled`, `exposure`, or `toolExposure` of an existing server. Removing an override may reveal an earlier definition. JSON comments and trailing commas load, but saving writes plain JSON and backs up the old file as `<file>.bak`.

Names allow letters, digits, `_`, and `-`. Stdio uses one executable in `command` (not a shell expression), plus optional `args`, `env`, and `cwd`. Relative `cwd` is resolved from the session directory; leading `~/` expands to home. `enabled` defaults to true and per-request `timeout` to 60 seconds. Invalid entries are reported and skipped independently.

`env` and HTTP `headers` support `${NAME}` expansion or a whole-value `!command`. Set `literalHeaders: true` to send headers verbatim. Stdio inherits a minimal environment plus configured `env`; `inheritEnv: true` passes the entire host environment. It does not sandbox the process. Keep credentials in user-level config, and use OS sandboxing or a container if a server needs restricted filesystem or network access.

The built-in `octocode` preset supplies defaults but uses this same host. `OCTOCODE_MCP=0` disables that default unless file configuration overrides it. The preset supplies workspace and loaded-skill paths to a local `octocode` server unless `ALLOWED_PATHS` is explicit. Its missing binary falls back to `npx` only in a trusted project. See [skill access](skills.md#understand-how-skills-load).

## Authentication

An HTTP server without an `Authorization` header can use OAuth. Run `/mcp login <server>` or `octocode mcp login <server>`, or choose **Sign in** in `/mcp`. If a remote browser cannot reach the loopback callback, paste its redirected URL. Tokens are stored in `<agent directory>/mcp-auth.json`, keyed by server name and URL, refreshed as needed, and deleted on sign-out. New scopes require sign-in again.

If the server does not support dynamic client registration, set `oauth.clientId`, optionally `clientSecret`, and `callbackPort` or `callbackUrl`. The callback must be loopback HTTP and end in `/callback`. `scope` overrides missing advertised scopes. `clientName` changes dynamic registration name; sign out before re-registering. `clientRegistration: "cimd"` requires `OCTOCODE_MCP_CLIENT_METADATA_URL` and cannot combine with `clientId` or `clientName`. `authServerMetadataUrl` overrides broken discovery with a trusted HTTPS metadata URL (loopback HTTP allowed).

A server can instead use a current `/providers` login:

```json
{
	"mcpServers": {
		"gateway": {
			"url": "https://gateway.example/mcp",
			"auth": { "provider": "gateway" }
		}
	}
}
```

The provider token is sent as a bearer token on each request, including after refresh. Because this routes credentials to the server URL, `auth` is accepted only in global config, with HTTPS except loopback. It cannot be combined with project replacement or OAuth. For the built-in research server, `GITHUB_TOKEN` or `GH_TOKEN` takes priority, then stored `/github` login, then `gh` CLI credentials.

## Connections and caching

`octocode mcp list` connects enabled servers, reports errors, and exits 1 on invalid entries or failed connections. `/mcp` shows server state and failed stdio stderr; notifications also go to rotated `<agent directory>/mcp.log`.

Connections begin in the background. The first prompt waits up to 10 seconds for direct/auto catalogs and 1.5 seconds for deferred-only catalogs. A call waits for its target server. Transient HTTP connection failures get two retries; three consecutive failures trigger a 5–60 second backoff until restart. Dropped connections reconnect on the next call. An expired HTTP session gets one fresh-session retry; ordinary tool calls are not retried because they may have changed server state.

Validated tool catalogs and instructions are cached in memory. Reconnect lists tools anew; disconnect or failed refresh withdraws them. Shutdown, authentication/configuration replacement, and workspace changes clear the cache. [Provider prompt caching](prompt-caching.md) is separate.

## Exposure and results

`auto` makes a small catalog direct. It defers when the combined non-`octocode` catalog exceeds 30 tools or 10% of the remaining input window, if native `tool_search` loading is available. Decisions update when that server's catalog, discovery availability, or selected model changes. Explicit `deferred` needs active `tool_search`; otherwise the tool is unreachable. Exact search names load, while ranked searches load strong matches.

`toolExposure` keys are exact tool names or `*` patterns: exact names win, then the first matching pattern. Legacy `codemode` exposure values load as `deferred`. `--tools` filters MCP tools only with an `mcp__` pattern; `--exclude-tools` also accepts these patterns. The `octocode` preset favors direct local research tools and deferred GitHub/package tools when loading is available.

MCP results retain text, images, structured data, and errors in session history. Resource content blocks become unsupported-content placeholders. Oversized text is saved under the session's `output/` folder, with an excerpt and path in the result. Generic server text keeps about 20 KB; the `octocode` preset allows 60,000 characters per part; all tool results then share the per-message 200,000-character budget. See [compaction and recovery](native-features.md#compaction-and-recovery).

To verify that a model uses a server, run `octocode --mode json --print --no-session "<task>"` with a disposable or read-only server, then check for a direct call or `tool_search` followed by a deferred call. Connection alone does not prove model use.

## Model management and permissions

The model's `mcp` tool supports `list`, `status`, `tools`, `connect`, `restart`, `stop`, session-only `add`, and `remove`. `tools` can inspect full descriptions and schemas without executing tools. A second restart within 10 seconds is refused. `stop` withdraws tools until explicit connect/restart. `add` requires user confirmation of the command or URL, working directory, and environment/header **names**, not values; a session unable to ask refuses it. These operations do not edit configuration. Child agents use their own connections and inherit eligible session registrations for their run.

Model MCP calls use the normal tool pipeline, including extension handlers and permission gates. Hook-initiated `mcp_tool` calls bypass repeated extension handlers but still check availability and permissions. MCP annotations do not affect permission decisions. MCP uses the ordinary `mcp.write` class; see [MCP permissions](permissions.md#mcp-tools) and [hook calls](permissions.md#hook-initiated-mcp-calls).

## Migrate from another client

Copy a Claude Desktop/Code or Cursor `mcpServers` entry. For VS Code, move an entry from `servers` and replace `${input:...}` with `${NAME}`. Convert Codex `[mcp_servers.<name>]` TOML to JSON. For OpenCode, split local `command` arrays into `command` and `args`, rename `environment` to `env`, and convert remote entries to `url`. Validate with `octocode mcp list`.

## Extensions and SDK

Extensions can register session servers with `octocode.registerMcpServer(name, config)`; file configuration wins on name conflicts. Shell `octocode mcp` commands do not load extensions. An extension registering `/mcp` replaces the built-in MCP host, including its default preset; an extension registering `tool_search` can replace discovery. See [extension servers](extensions.md#mcp-servers) and [tool exposure](extensions.md#tool-exposure).

Disable built-in MCP for one run with `--no-mcp`, or persistently through Built-in settings / `"-builtin:mcp"`. SDK sessions must call `await session.bindExtensions({})` to start extension lifecycles. See [MCP SDK integration](sdk.md#mcp).
