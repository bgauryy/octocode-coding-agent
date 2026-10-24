# MCP Servers

Octocode connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio, streamable HTTP, or legacy SSE and makes their tools and resources available to the model.

## Quick setup

Add a local stdio server, check the connection, then start Octocode:

```bash
octocode mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
octocode mcp list
octocode
```

For a remote server:

```bash
octocode mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
octocode mcp list
```

These commands add user-level servers by default. Add `--local` or `-l` to write the project configuration instead:

```bash
octocode mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

Use `/mcp` inside an interactive session to inspect connections, sign in, reconnect, change exposure, or enable and disable servers. Run `/reload` after adding, removing, or changing a server outside the session.

Use `/mcp config` or `octocode mcp config` to show global and workspace files, their precedence, and workspace trust status. For the locations of skills, models and other settings, see [CONFIGURATIONS.md](../../../CONFIGURATIONS.md).

## Configure servers

With the default home, Octocode reads global MCP files in this order, from lowest to highest priority:

1. `~/.pi/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `~/.octocode/mcp.json`
4. `~/.octocode/agent/mcp.json`
5. `~/.octocode/octocodecode/mcp.json` (the canonical writable file)

An explicit `OCTOCODE_HOME`, `OCTOCODE_CODING_AGENT_DIR`, or custom SDK agent directory isolates configuration: only that agent directory's `mcp.json` is loaded globally. Project configuration is read only after project trust is granted, and only while `/trust`'s record of these files' exact content matches: a server added or an entry edited after you trusted the project stays unloaded, and a notice says to run `/trust`. A default SDK `SettingsManager` treats the project as untrusted, so an SDK session loads no project MCP files unless the host passes `projectTrusted: true`. From lowest to highest priority, it reads `.pi/mcp.json`, `.mcp.json`, `.agents/mcp.json`, and `.octocode/mcp.json` in the session directory. A full transport entry replaces an earlier entry with the same name; credentials from a replaced transport are not merged.

All these files use the common `mcpServers` JSON object. Line comments and trailing commas are accepted. `.mcp.json` lets a project share configuration with Claude Code; `.agents/mcp.json` is also accepted by Octocode, but is not an MCP protocol standard. Octocode does not automatically execute server configurations from unrelated desktop or editor profiles. Use the conversion table below for those clients.

The session, MCP CLI commands, and built-in Octocode server ownership check use the same loader. A valid configured `octocode` entry takes precedence over the automatic research server, including `enabled: false`, so it is not launched twice. Global enablement and exposure changes save controls in the canonical file; they do not rewrite an inherited Pi or shared Octocode file or copy its credentials. Shell `mcp add` and `mcp remove` operate on Octocode's native file. Removing a canonical entry may reveal an inherited server again; disable it to keep it off. Saving JSON atomically replaces the file and preserves unrelated fields but removes comments, so a file with comments is first copied to `<file>.bak`.

An entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and `toolExposure` of an earlier server with the same name and keeps the rest, including `env`, `headers`, and `auth`. This works across global layers and trusted projects. A control-only entry requires an earlier transport definition. For example, this turns off an inherited server:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

The format matches other MCP clients:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

Stdio servers use `command`, `args`, `env`, and `cwd`. Relative `cwd` values resolve against the session directory. A leading `~/` in `command`, an argument, or `cwd` names the home directory.

For a local server named `octocode`, native sessions supply workspace and loaded-skill path defaults unless `ALLOWED_PATHS` is explicit in configuration or the process environment. These launch defaults do not rewrite files. See [skill access](skills.md#understand-how-skills-load). The automatic Octocode server restarts when skills discovered later change the folders it may read (the same folders in another order change nothing), and not while one of its calls runs. If the installed `octocode-mcp` is missing, the automatic server falls back to `npx` only in a trusted project, because `npx` could otherwise start a package from the project's `node_modules`.

URL servers use streamable HTTP by default. For an older MCP SSE endpoint, set `"type": "sse"` with the endpoint in `url`; the server advertises its same-origin message endpoint over the event stream. Both URL transports support `headers`, `oauth` (see [Authenticate with OAuth](#authenticate-with-oauth)), and `auth` (see [Use a provider login](#use-a-provider-login)).

Both server types support:

- `timeout`: per-request timeout in seconds (default 60). Progress notifications reset it.
- `enabled`: defaults to `true`. Set `false` to keep the entry without connecting to it.
- `exposure` and `toolExposure`: control how tools reach the model (see [Control tool exposure](#control-tool-exposure)).
- `inheritEnv`: stdio only; defaults to `false`. A stdio server receives only a minimal host environment (HOME, LOGNAME, PATH, SHELL, TERM, USER, the MCP SDK allow-list, with a Windows set on Windows) plus the configured `env` (`$VAR` values still resolve). Set `true` to pass the whole host environment, tokens included. Use an absolute command path or supply `PATH` explicitly. This controls environment inheritance, not OS sandboxing.
- `description`: what the server offers, in a sentence. It lists the server in the system prompt (see [Control tool exposure](#control-tool-exposure)), tool search ranks the server's tools by it. Without it, the first line of the server instructions is used once the server connects.

Keep personal servers and servers with credentials in the user-level file. Use the project file only for servers the project requires, and only in trusted projects.

### Configuration rules

- Server names may contain only letters, digits, `_`, and `-`. Tools are named `mcp__<server>__<tool>`, with every character other than letters, digits, and `_` replaced by `_`; tools of a server whose names then collide all get a hash suffix. Server names that differ only in `-` and `_` count as the same server. Conflicting names in one file are rejected; later files override earlier aliases, and a `mcp.json` server overrides a registered one.
- `type` is optional. A `command` selects stdio and a `url` selects streamable HTTP. Set `"type": "sse"` for a legacy SSE URL; `http` and `streamable-http` select streamable HTTP.
- `command` is one executable and `args` contains its arguments. It is not a shell command string.
- `env` and `headers` values can use environment variables such as `${GITHUB_TOKEN}`. They can also run a command with `!command`, but the command must make up the whole value, for example `"Authorization": "!echo Bearer $(gh auth token)"`.
- For an HTTP or SSE server, `"literalHeaders": true` sends the configured header strings verbatim; `${NAME}` and `!command` then remain literal text. This is useful when a host integration has already supplied header values. The default is `false`.
- Invalid entries are reported and skipped without preventing other servers from connecting.

`octocode mcp add` and `octocode mcp remove` cover common changes from a shell. See MCP commands for their options.

### Inspect or change a server

`/mcp` lists configured servers with their state, tool count, exposure, and configuration source. Servers that need attention appear first. Select a server to inspect its tools and connection details, reconnect, sign in or out, change exposure, or enable and disable it.

`/mcp tools` lists the current tool catalog for all servers; add a server name to narrow it. `/mcp tools <server> <tool>` shows the full description and input schema. The manager's **Tools** view supports the same inspection, including automatic Octocode tools. These views inspect the current snapshot without executing tools or starting disabled servers. Disconnected servers show no available tools.

The model can inspect the same snapshot with `mcp({ intent: "tools", server: "octocode" })`; add `tool: "localFetch"` to retrieve one complete contract. This exposes descriptions and schemas, not credentials, filesystem access or implementation source. Reviewing source outside the configured roots still requires an explicit `ALLOWED_PATHS` configuration change by the user.

From a shell, `octocode mcp tools [server] [tool]` connects enabled configured servers and prints their tools; specifying a server connects only that server. `octocode mcp tools --json` includes descriptions, input schemas and exposure. `octocode mcp config --json` prints only configuration locations and trust state, with no credentials or server connections.

Global exposure and enabled-state changes are saved to the canonical global file. Existing project overrides remain the target for subsequent changes. In a trusted project, "Enable in this project" and "Disable in this project" add a project override for a user-level server. Disabled servers remain listed, and their exposure can be changed before enabling them. `/mcp list` prints the current snapshot without waiting for a connection. `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` perform those actions directly. `/mcp reconnect all` reconnects every enabled server, including the automatic Octocode server, and reports the ones that failed.

Configure a server from either interface:

| In a session | From a shell |
| --- | --- |
| `/mcp enable docs` | `octocode mcp enable docs` |
| `/mcp disable docs` | `octocode mcp disable docs` |
| `/mcp exposure docs direct` | `octocode mcp exposure docs direct` |

Exposure accepts `auto`, `deferred`, `direct`, or `hidden`. Add `--local` to save a trusted project override. Shell mutations do not connect servers; running sessions need `/reload` or the corresponding `/mcp` action. Shell commands also support `add`, `remove`, `list`, `login`, and `logout`, and do not load extensions.

`/status` lists every loaded skill followed by MCP servers, including the automatic Octocode research server, with enabled state, connection state, exposure, tool count, and source. The startup resource display shows Skills followed by MCPs and refreshes as servers connect; quiet startup still applies. `/mcp list` also includes the automatic server. Without an explicit `octocode` configuration, its controls remain `OCTOCODE_MCP=0` and `/mcp reconnect octocode`. Configure an explicit server to manage its persistent enablement and exposure through `/mcp`.

### Sign in to GitHub for research

The research server's GitHub tools use the first token they find: an environment token such as `GITHUB_TOKEN` or `GH_TOKEN`, then a stored Octocode login, then the `gh` CLI. `/github` shows which account and source are active, and starts a sign-in when there is no token. `/github login` runs the native Octocode CLI's GitHub device flow: the dialog shows the URL and code to enter, and Esc cancels. `/github logout` removes the stored login; environment and `gh` credentials are unchanged. The research server reads the stored login again within a minute, so it needs no reconnect. An environment token still takes priority over a stored login until you unset it, and `/github` says so. The same commands are available in a shell as `octocode native auth status`, `login` and `logout`.

### Let the model manage servers

The `mcp` tool lets the model check and recover the servers of its own session without changing any configuration file:

| `intent` | Effect |
| --- | --- |
| `list`, `status` | State, tool count and last error of every server, or of `server` |
| `connect`, `restart` | Start a stopped or failed server, or restart a running one. A second restart of the same server within 10 seconds is refused. |
| `stop` | Stop `server` for the rest of the session and remove its tools; `connect` starts it again |
| `add` | Run a new server for this session from `config` (`command`, `args`, `env`, `cwd`, or `url`, `headers`). The user confirms first: the dialog shows the command or URL, the working directory, and the names (never the values) of the environment variables or headers; a session that cannot ask the user refuses. |
| `remove` | Remove a server that `add` started |

A subagent acts on its own MCP connections, never on its parent's. A subagent started after a server was added with `add` also runs that server (the user's confirmation covers it): the parent passes the definition through an owner-only temporary file that is removed when the run ends, so it appears in the child's `mcp_servers` section and tools like any other server, and nothing is written to `mcp.json`. A server stopped or removed beforehand is not passed on, and servers added later reach only subagents started after that. Servers from configuration files are not removed; the user disables them with `/mcp disable`. The tool belongs to the default tool selection like a built-in tool: `--no-builtin-tools`, a `defaultTools` setting or a `--tools` list without `mcp` leaves it out.

### Diagnose connection problems

Run `octocode mcp list` to connect to every enabled server and print its state, tools, and errors. It exits with status 1 when an entry is invalid or an enabled server is not connected. `/mcp` shows the full connection error and the tail of stderr from a failed stdio server.

Octocode reports configuration errors, failed connections, and required sign-ins once after startup. Server logging notifications are appended to `<agent directory>/mcp.log` as `<time> [<server>] <level> <logger>: <message>`. The file moves to `mcp.log.1` after it grows past 5 MB.

Octocode connects enabled servers in the background. The first prompt waits up to 10 seconds for `direct` and `auto` catalogs, and up to 1.5 seconds more in parallel for servers whose tools are all `deferred`, so a fast one lists its tool names in the first `mcp_servers` section; a slower one is listed by name only until the next prompt, and a hanging one never holds the prompt longer than that. A native tool call waits for its server; scoped `tool_search` waits for its namespace, while unscoped discovery and resource calls wait for all relevant servers. HTTP network errors and transient statuses (408, 429, and 5xx) are retried twice. Dropped connections reconnect on the next call. A server that fails to connect three times in a row (for example a stdio command that exits at once) is not started again for a growing pause (5 s doubling to 60 s): its calls fail at once with an error that says so, until the pause ends or the server is restarted. Tool-list changes register new tools and make withdrawn tools unreachable.

When an HTTP session expires, Octocode retries once with a new session. Calls already using the old connection can finish before its transport closes. Stopping the server or closing the agent session also closes these retired connections, even if their calls are still pending.

Stdio is language-independent: `command` may be a native executable, a Python interpreter with the script in `args`, a Node process, or a container launcher. Arguments are passed as an array without a shell. To restrict filesystem or network access, configure an OS sandbox/container launcher as the command; the host does not silently add one. The default minimal environment limits inherited credentials but does not isolate files or the network.

Stopping a stdio server closes its stdin, sends SIGTERM, then sends SIGKILL to its process group. This also stops servers launched through wrappers such as `npx` or `uvx`.

### Catalog caching

Each running connection keeps a validated catalog: server instructions and complete tool metadata, including descriptions, input schemas and output schemas. Unchanged definitions keep their identity and ordering when the server merely reorders its listing. Changed definitions or instructions replace the relevant cached metadata.

Reconnect always initializes and lists tools again before restoring them. Disconnects and failed refreshes withdraw tools and instructions; late replies cannot overwrite a newer catalog. Shutdown, authentication/configuration replacement, and native workspace changes discard the relevant cache. Disabled servers are not connected or advertised. Catalogs are kept in memory, not persisted across application restarts. This metadata cache supports stable model input; provider prompt-cache hits remain subject to the provider's rules. See [prompt caching](prompt-caching.md).

## Migrate configuration from another client

Move the converted entry under `mcpServers` in `mcp.json`, then run `octocode mcp list` to validate it.

| Client | Conversion |
|---|---|
| Claude Desktop, Claude Code, or Cursor | Copy the existing `mcpServers` entry. |
| VS Code | Move an entry from the top-level `servers` object and replace `${input:...}` prompts with `${NAME}` environment variables. |
| Codex | Convert `[mcp_servers.<name>]` TOML fields such as `command`, `args`, `env`, and `url` to JSON. |
| OpenCode | Convert `"type": "local"` to a stdio entry, split its `command` array into `command` and `args`, rename `environment` to `env`, and replace `{env:NAME}` with `${NAME}`. Convert `"type": "remote"` to a URL entry. |

## Authenticate with OAuth

Remote servers that use OAuth, such as Sentry, need no credentials in `mcp.json`:

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

When the server rejects an unauthenticated connection, `/mcp` shows that it needs sign-in. Select "Sign in", run `/mcp login sentry`, or run `octocode mcp login sentry`. Octocode opens the authorization page and waits for approval. If the browser runs on another machine, such as over SSH, paste its redirected URL into the sign-in screen. A running session uses the new credentials on its next turn.

Octocode registers itself with the authorization server, stores tokens in `<agent directory>/mcp-auth.json`, and refreshes access tokens when they expire or the server rejects them. If a server later requests additional scope, Octocode asks for sign-in again; the standalone `@octocodeai/octocode-mcp` package's `adaptOAuthProvider` steps up silently instead, and Octocode does not use it. Signing out deletes the stored credentials.

Credentials belong to a server name and URL. Servers with the same URL under different names, such as one per account, sign in separately; servers with the same name and URL in different `mcp.json` files share one sign-in.

OAuth applies to HTTP servers without an `Authorization` header. For a server that does not support dynamic client registration, configure a registered client:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

The redirect URI must match the registered URI. `callbackPort` uses `http://127.0.0.1:<port>/callback`. To use another URI, set `callbackUrl`; it must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Octocode sends it exactly as written. When `callbackUrl` omits a port, Octocode uses `callbackPort` or a free port and adds it to the URI, as allowed for loopback redirects by RFC 8252. `clientSecret` is optional and can use an environment variable or command.

Set `scope` to a space-separated list for servers that do not advertise their required scopes. Otherwise, Octocode requests the advertised scopes. Later scope requests are added to the configured value.

Octocode registers as `octocode`. Some servers only accept registrations from known clients. Set `clientName` to send another name:

```json
{
  "mcpServers": {
    "figma": { "url": "https://mcp.figma.com/mcp", "oauth": { "clientName": "Claude Code" } }
  }
}
```

The name is only sent when Octocode registers a client. To register again under a new name, sign out first.

Some authorization servers allow clients by their Client ID Metadata Document URL instead of registering them. Set `OCTOCODE_MCP_CLIENT_METADATA_URL` to the base URL of your hosted client metadata documents, then set `clientRegistration` to `cimd`. Without that environment variable, this mode fails explicitly:

```json
{
  "mcpServers": {
    "example": { "url": "https://mcp.example.com/mcp", "oauth": { "clientRegistration": "cimd" } }
  }
}
```

The client ID is `<OCTOCODE_MCP_CLIENT_METADATA_URL>/client.json` with the redirect URI `http://127.0.0.1:<port>/callback`. If the authorization server does not send the `iss` parameter in authorization responses (RFC 9207), Octocode uses a document and redirect path specific to the MCP server instead: `<OCTOCODE_MCP_CLIENT_METADATA_URL>/<id>/client.json` with `http://127.0.0.1:<port>/callback/<id>`. The authorization server must advertise Client ID Metadata Document support and public clients, or sign-in fails. `cimd` cannot be combined with `clientId` or `clientName`, and a `callbackUrl` must use `localhost` or `127.0.0.1` with the path `/callback`.

Octocode finds the authorization server through the server's protected resource metadata (RFC 9728) and checks that the authorization server's metadata names the expected issuer (RFC 8414). Some servers advertise the wrong authorization server or none, so sign-in opens a page that does not exist. Set `authServerMetadataUrl` to the metadata document of the right authorization server:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration" }
    }
  }
}
```

Octocode uses that document instead of discovery and trusts it as configured, so only point it at a document you trust. The URL must use HTTPS, except on `localhost`, `127.0.0.1`, or `[::1]`.

## Use a provider login

A server that accepts the token of a model provider you signed in to with `/providers` can use it instead of OAuth, for example a gateway in front of that provider:

```json
{
  "mcpServers": {
    "gateway": { "url": "https://gateway.example/mcp", "auth": { "provider": "gateway" } }
  }
}
```

Octocode sends the provider's current token as `Authorization: Bearer <token>` on every request, so refreshes of the login apply without a reconnect. The token is not stored in `mcp.json` or `mcp-auth.json`. If the server rejects it, the server shows as needing sign-in and the error names `/providers <provider>`. The same applies to `octocode mcp list`, which reads the credentials of the agent directory.

`auth` is the credential routing: the token goes to the server's `url`. For that reason it is accepted only in the global `mcp.json`: a project file that sets it is reported and skipped, so a repository cannot choose where a credential is sent, and it cannot replace a global server that uses `auth`. The `url` must use HTTPS, except on `localhost`, `127.0.0.1`, or `[::1]`. A server with `auth` does not use OAuth, and an `Authorization` header is not needed.

## Control tool exposure

Each server tool is registered as `mcp__<server>__<tool>`. The server's `exposure` determines how the model reaches it:

| Exposure | Behavior | Typical use |
|---|---|---|
| `auto` (default) | Small catalogs are direct. Automatic tools are deferred when the combined catalog of all enabled servers (their direct tools plus their automatic tools, without the `octocode` server's) has more than 30 tools, or its estimate reaches 10% of the model window remaining after its maximum output reserve. This applies only when native tool loading and discovery are available; transports without native loading stay direct, however many tools there are. The estimate uses serialized catalog bytes divided by four. Decisions are made once the startup wait ends, in server name order, so connection order does not change them. After that each decision holds until the server's own tools change, discovery becomes available or unavailable, or the selected model changes: a model switch decides every server again, so tools can move between direct and deferred then. Another server connecting or leaving later never moves them. | Automatic exposure. |
| `deferred` | Not declared until `tool_search` loads a match for the next model call. | MCP tools called directly after discovery. |
| `direct` | Declared to the model like a built-in tool. | Small, frequently used tool sets. |
| `hidden` | Registered but unreachable. | Servers or tools that should remain unavailable. |

Legacy `codemode` and `codemode-deferred` exposure values load as `deferred`. The executor has been removed; see [migration](codemode.md).

Every enabled server except `octocode` is listed in the `mcp_servers` section of the system prompt: how its tools are reached (`declared` or `tool_search`), one line from the configured `description` or else from the server instructions, the tools `tool_search` loads (sorted by name, without the `mcp__<server>__` prefix, each with the first line of its description cut to 80 characters; deferred tools count only while `tool_search` is active), and up to 512 characters of the rest of the server instructions. At most 40 tools are listed per server; the rest are counted, and `tool_search` still finds them. The section stays within 6,144 characters: instructions shrink first, then tool descriptions (names stay), then summaries and tool lists, then the last servers are counted in a closing line. The `octocode` server is indexed in the `octocode` section instead, which carries its whole instructions and names its deferred tools. Octocode updates the section when a prompt starts, after waiting for servers with `direct` tools; a deferred server that is still connecting is listed by name until a later prompt. When the section changed, for example because a server connected, Octocode appends the new section to the conversation, so earlier messages stay cached. A newly connected server's direct tools are still added to the tool declarations. MCP tools are declared sorted by server namespace and then name, after the other tools, so the declared tools do not depend on which server connected first; within one session the order holds until tools are added or removed. The `namespace` option of `tool_search` accepts the server name or its MCP namespace.

A `tool_search` query that names a deferred tool exactly (full or short name) always loads it. Other matches are ranked, and a ranked match loads only when its score is at least half of the best score, up to the `limit` (default 8), so a generic word loads the strong matches instead of every tool that mentions it. When more tools matched than loaded, the result says so (for example, "Loaded 2 of 8 matching tools"). The result lists the loaded tools, names matching tools that are already loaded (the same cutoff applies), and, when nothing matches, the namespaces that still have tools to load. A call to a deferred tool before it is loaded fails without reaching the server; the error keeps the `Tool <name> not found` prefix and tells the model to load it with `tool_search` first. This guards the model's own calls. A tool that calls other tools through `ctx.executeTool()` can reach a registered deferred tool without loading it; permissions still apply (see [Tool exposure](extensions.md#tool-exposure)).

With `auto`, Octocode decides a server's tools when the startup wait ends, and again when its own tools change, when discovery becomes available or unavailable, and when the selected model changes (which decides every server again); in between the decision is kept. Native tool loading means the model's transport can add tools in the middle of a conversation without rewriting the cached tool list: it needs `supportsMidConvoSystemMessages` plus `supportsMidConvoToolChanges` (Anthropic Messages), `supportsAdditionalTools` or `supportsToolSearch` (OpenAI Responses), or `supportsMidConvoToolAdditions` (Chat Completions); see [model compatibility](models-configuration.md#compatibility). Explicit `direct`, `deferred`, and `hidden` settings override this policy. Octocode activates `tool_search` when tools are deferred. The model searches for a capability (optionally passing `namespace` to target one server without waiting for the others), receives the matching schemas, then calls the named MCP tools directly through the normal validation, permission and cancellation pipeline. To make the model see a tool without searching, give it `direct` exposure with `toolExposure`.

The `octocode` server has a default split. Without an `exposure` of its own, its local research tools are `direct`: `localFetch`, `localSearch`, `structureSearch`, `astSearch` and `lspSearch`, plus the older names `localGetFileContent`, `localSearchCode`, `localFindFiles`, `localViewStructure` and `lspGetSemantics` if an older server offers them. Its GitHub and package tools are `deferred` when `tool_search` is available and the model has native tool loading, whatever the catalog size, and `direct` when `tool_search` is not available. On a model without native tool loading, a `tool_search` load rewrites the cached prompt once, so these tools are `deferred` there only when their estimated size reaches 10% of the model window remaining after its maximum output reserve, and `direct` otherwise. Octocode search tools that are declared or loadable through `tool_search` replace the system prompt's generic rule to search with bash, so loading one does not change the rules. The automatic Octocode server and an `octocode` entry in `mcp.json` behave the same. Subagents declare the same local tools, because their profiles name them. An `exposure` on the server entry applies to every tool and replaces the split; a `toolExposure` entry changes one tool, for example `"toolExposure": {"lspSearch": "deferred"}`. The file guard counts a `localFetch` read as evidence for a later `file` change only when the model called it directly, not when another tool called it.

`toolExposure` overrides the server exposure for individual tools. Keys are exact server tool names or patterns where `*` matches any characters. Exact names win over patterns; among patterns, the first match wins. A server with `hidden` exposure can expose only selected tools:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "deferred",
        "delete_*": "hidden"
      }
    }
  }
}
```

`octocode mcp list` marks tools whose exposure differs from their server. The Tools view in `/mcp` also shows the effective exposure.

Tools loaded by `tool_search` are recorded in the transcript. Their declarations survive compaction, resume, and fork on that branch; navigating to an earlier branch restores that branch’s loadout.

`--tools` does not remove MCP tools unless one of its entries starts with `mcp__`; `octocode --tools bash,tool_search,'mcp__github__*'` keeps only the MCP tools of `github`. `--exclude-tools` accepts the same patterns, and `--no-mcp` disables MCP for one run (see Tools).

If explicitly deferred tools have no active discovery tool, Octocode warns that they cannot be called. Enable `tool_search` or choose `direct` exposure. Octocode activates `tool_search` for deferred tools once per session (and again after session start or tree navigation); if an extension or the SDK deselects it later, Octocode warns instead of activating it again.

Both paths save an oversized text whole in the session's `output/` folder (owner-only; the same helper as other tools' saved output) and show its start and end around an omission note that names the file, so it can be searched or read by line range. They differ in budget: text results from configured servers keep about 20 KB, with no per-message total. The built-in Octocode server lets each text part keep up to 60,000 characters, because it pages its own output. Every tool's results, MCP and native, then share one per-message budget of 200,000 characters with the overflow recoverable from an archive; see [Compaction and recovery](native-features.md#compaction-and-recovery).

MCP results retain text, image, structured data, and error information. Unsupported binary resources are saved to files. The host renders results and preserves them in session history independently of the server connection.

To check model behavior, run a realistic request with `octocode --mode json --print --no-session "<task>"` against a disposable or read-only server. Inspect the tool-call and result events: a direct tool should be callable immediately; a deferred tool should be discovered and then called with its declared arguments. Check that the final answer uses the returned data. A connected server or a successful `tools/list` alone does not prove the model can use it. Test small automatic catalogs and deferred catalogs separately, using fresh sessions. See [skill validation](skills.md#validate-and-share-a-skill) for the corresponding instruction-loading check.

## Use resources

When a connected server offers [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), Octocode adds the resource tools used by Codex and OpenCode:

- `list_mcp_resources` lists resources as JSON: `{ server?, resources: [{ server, uri, name, ... }], nextCursor? }`. With `server`, it lists one page; `cursor` continues with the next page. Without `server`, it lists every resource from every server.
- `list_mcp_resource_templates` lists URI templates for resources the servers do not list directly.
- `read_mcp_resource` reads a resource by `server` and `uri`. Text reaches the model as text and images as images. Other binary resources are saved to temporary files, and the model receives the path.

Pass cursors unchanged, including whitespace, together with the same `server`. The host supplies each listing's server identity from its connection; a resource payload cannot override that routing field. Canceled management calls cannot add, stop or remove a server; cancellation while an add confirmation is open also prevents registration.

These tools reach every enabled, non-hidden server with resources. Their exposure is the widest exposure among those servers: `direct`, then `deferred`. Resource links in tool results identify `read_mcp_resource` and the server.

Resources for MCP Apps, identified by `ui://` URIs or `text/html;profile=mcp-app`, are omitted because Octocode does not render them. Resource icons are also omitted.

Reading and listing resources is retried once after a transient HTTP error (408, 429, or 5xx). Tool calls are not retried after a transient HTTP error because the server may already have performed them. The one exception is an expired HTTP session (a 404 for a session the server no longer knows): the server did not run the request, so Octocode retries it once on a new session.

## Permissions

Every MCP call the model makes passes through Octocode's tool pipeline. Extension `tool_call` and `tool_result` handlers, including permission gates, therefore apply to MCP tools. Nested calls made by extensions retain `parentToolCallId`.

A call made by an `mcp_tool` [hook](hooks.md) does not go through that pipeline, because the hook's own PreToolUse hooks and extension handlers would run for it again. It is still checked: the MCP owner refuses a tool that is hidden or no longer offered, and Octocode's permission gate decides it like a model call (see [Hook-initiated MCP calls](permissions.md#hook-initiated-mcp-calls)). An extension that needs to see these calls cannot observe them through `tool_call`.

`octocode.getAllTools()` reports the annotations declared by each server: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Permission extensions can use these hints to decide which calls require confirmation (see [Tool exposure](extensions.md#tool-exposure)). Octocode's own permission gate does so too: it skips the ask in `manual` for a tool the server marks `readOnlyHint: true`, although the MCP specification says clients must treat these hints as untrusted, and in the default `full` mode no MCP call asks. See [MCP tools](permissions.md#mcp-tools). Resource tools are marked read-only.

## Extensions and SDK

### Add servers from extensions

Extensions can add servers for the current session with `octocode.registerMcpServer(name, config)`, using the same shape as an `mcpServers` entry (see [MCP servers in extensions](extensions.md#mcp-servers)). Registered servers connect like configured servers and appear in `/mcp` with the extension as their source.

Changes to enabled state or exposure apply only to the current session. A file-configured server with the same name takes precedence, and `/mcp` lists the overridden registration. `octocode mcp` shell commands do not load extensions and only see file-configured servers.

### Replace the built-in MCP support

An installed extension that registers `/mcp`, such as `pi-mcp-adapter`, replaces the built-in MCP support for sessions. The built-in extension then does not connect the servers of `mcp.json`, and `/mcp` belongs to the extension. Remove the extension to restore the built-in behavior. To disable built-in MCP support without a replacement, disable `mcp` under Built-in in `octocode config`, or set `"extensions": ["-builtin:mcp"]` in settings. `--no-mcp` disables it for one run.

The native Octocode extension is not replaceable and still reads `mcp.json` to decide who runs the `octocode` server: with a valid `octocode` entry it does not start the automatic server and leaves that entry to whichever MCP support is installed, and without one it starts the automatic server unless `OCTOCODE_MCP=0`.

An extension that registers `tool_search` similarly replaces the built-in tool with that name. Octocode activates the replacement for MCP servers and waits for the servers its calls need only when it declares [`reachesTools`](extensions.md#tool-exposure). Shell-level `octocode mcp` commands always use the built-in implementation.

### Use MCP from the SDK

The default SDK resource loader includes native features and the built-in MCP and tool-search extensions. Call `await session.bindExtensions({})` before prompting to start their lifecycle. Custom loaders can opt out with `nativeFeatures: false` and supply selected factories explicitly. See [MCP SDK integration](sdk.md#mcp) for activation and cleanup.
