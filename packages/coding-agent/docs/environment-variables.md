# Environment Variables

Octocode uses environment variables in three ways:

- Variables such as `OCTOCODE_OFFLINE` configure the Octocode process.
- Octocode sets process markers so child processes can identify Octocode as the launching agent.
- Commands run by the LLM-callable shell tools receive `OCTOCODE_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=octocode` is a generic marker that lets tooling identify Octocode as the agent that launched the process.
- `OCTOCODE_CODING_AGENT=true` is Octocode-specific and lets child processes detect that they run inside Octocode.

Child processes inherit both markers. They are not session-specific and are not set automatically when Octocode is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the native `bash` tool, using either `type: "bash"` or `type: "powershell"`, receive the current Octocode session state:

| Variable | Description |
|----------|-------------|
| `OCTOCODE_SESSION_ID` | Current session ID |
| `OCTOCODE_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `OCTOCODE_PROVIDER` | Currently selected model provider |
| `OCTOCODE_MODEL` | Currently selected model ID |
| `OCTOCODE_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Octocode. `OCTOCODE_PROVIDER` and `OCTOCODE_MODEL` identify the selected Octocode model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$OCTOCODE_PROVIDER" "$OCTOCODE_MODEL"
printf 'reasoning=%s session=%s\n' "$OCTOCODE_REASONING_LEVEL" "$OCTOCODE_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$OCTOCODE_SESSION_FILE" ]; then
  tail -n 1 "$OCTOCODE_SESSION_FILE"
fi
```

These variables are injected into both shell modes of the LLM-callable `bash` tool and the standalone SDK `bash` tool. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` expose the session environment by default when registered with Octocode. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const quietBashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Octocode removes inherited values for these variables so nested Octocode processes do not expose stale parent-session metadata.

## Octocode Process Configuration

These variables are read by Octocode itself:

| Variable | Description |
|----------|-------------|
| `OCTOCODE_MODEL_CATALOG_URL` | Compatible remote catalog service base URL; no default upstream service |
| `OCTOCODE_MCP_CLIENT_METADATA_URL` | Hosted OAuth client metadata base URL required for MCP `cimd` registration |
| `OCTOCODE_HOME` | Override configuration and runtime root; default is `~/.octocode/octocodecode` |
| `OCTOCODE_CODING_AGENT_DIR` | Override the core config directory independently of `OCTOCODE_HOME` |
| `OCTOCODE_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `OCTOCODE_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `OCTOCODE_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `OCTOCODE_SKIP_VERSION_CHECK` | Disable the npm latest-version request for `@octocodeai/octocodecode` |
| `OCTOCODE_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `OCTOCODE_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `OCTOCODE_INSTRUCTION_CACHE_SPLIT` | Set to `off` to send the leading system prompt as one instruction cache block instead of two; see [second instruction block](prompt-caching.md#second-instruction-block) |
| `OCTOCODE_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `OCTOCODE_BUG_REPORT_URL` | Endpoint that `/bug` uploads reports to; without it, reports are exported as Zip files |
| `OCTOCODE_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor |
| `OCTOCODE_CLIPBOARD_OSC52` | Set to `1` to also send copied text to the terminal with OSC 52 after the local clipboard write, as Octocode does over SSH. Use it when a remote client reaches Octocode without SSH variables, such as a multiplexer attached from another machine or a remote IDE daemon |
| `OCTOCODE_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `OCTOCODE_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise Octocode reports only after the terminal confirms support |
| `OCTOCODE_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `OCTOCODE_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `OCTOCODE_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `OCTOCODE_TUI_PASTE_TIMEOUT` | How long a bracketed paste may go without input before it is accepted without its end marker, in milliseconds; defaults to `3000` over SSH and `1000` otherwise. Increase if long pastes over a slow link arrive split |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).

## Native feature configuration

These controls belong to the integrated Octocode features. Child identity, grants and nonce variables are set by the runtime and are not user configuration.

| Variable | Behavior |
| --- | --- |
| `OCTOCODE_PERMISSION` | Session start mode: `manual`, `workspace` or `full`; default `full` |
| `OCTOCODE_MAX_SUBAGENTS` | Maximum concurrent subagents; default `3` |
| `OCTOCODE_SUBAGENT_LINGER_SECONDS` | Seconds a finished background subagent stays resumable by a message to its id; default `0` (off). A subagent that reported `blocked` stays resumable for at least 600 seconds regardless |
| `OCTOCODE_MCP` | Set to `0` to disable automatic Octocode research MCP startup; an explicitly configured `octocode` server is managed through [MCP configuration](mcp.md) |
| `OCTOCODE_HOOKS` | Set to `1` at startup to enable [command hooks](hooks.md); off by default; children also require `hooks: true` in their profile |
| `OCTOCODE_HOOKS_COMPAT` | Set to `1` for the partial [Claude permission-rule preview](permissions.md#claude-permission-rule-preview); also set `OCTOCODE_HOOKS=1` to execute [source-profile hooks](hooks.md#source-profile-preview). Unset/`0` keeps source rules inactive and legacy hook behavior |
| `OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS` | Whole seconds a foreground `bash` command may run before it moves to the background as a job; overrides the `bashBackgroundAfterSeconds` setting. Default `90`; `0` turns the automatic move off |
| `OCTOCODE_EDIT_DIAGNOSTICS` | Bounded post-edit LSP and before/after parser observations; enabled by default, `0` disables them. Receipts and file guards remain active |
| `OCTOCODE_EXTRA_SKILLS` | Set to `0` to disable extra skill directories |
| `CLAUDE_CONFIG_DIR` | Select Claude user settings for hook/permission previews and Claude extra skills; project paths remain unchanged. See [hook discovery](hooks.md#discovery) |
| `CODEX_HOME` | Select an existing Codex user directory for hook preview and extra skills; invalid overrides do not fall back to the default directory |
| `OCTOCODE_MEMORY_AUTO` | Set to `0` to disable automatic memory injection for this process |
| `OCTOCODE_AGENT_DB` | Override the durable agent database file |
| `OCTOCODE_CLEANUP_DAYS` | Retention for kept session output and bash logs; default `30` days; `0` disables the sweep |
| `OCTOCODE_NOTIFY` | Answer notifications: `off`, `unfocused` (default) or `always` |
| `OCTOCODE_NOTIFY_METHOD` | Notification protocol: `osc9`, `osc777`, `osc99` or `bel`; otherwise detected from the terminal |
| `OCTOCODE_API` | Set to `1` to enable the local session API; off by default |
| `OCTOCODE_API_HTTP` | Enable loopback HTTP on this port (`0` chooses an available port), even without `OCTOCODE_API=1` |

See [native features](native-features.md) for runtime ownership and [configuration](configuration.md) for storage paths and compatibility.
