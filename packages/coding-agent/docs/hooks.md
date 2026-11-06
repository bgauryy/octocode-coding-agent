# Hooks

A hook is an event handler, separate from a [plugin container](plugins.md) and an instruction-based [skill](skills.md).

Command hooks run shell commands at selected lifecycle events. They receive JSON on stdin and return exit codes or supported JSON output. Octocode reads a subset of Claude/Codex-style JSON configuration; it does not implement either host's complete protocol.

Use [packages](packages.md) to distribute skills, prompts and themes. The native event handlers the runtime registers for itself are separate from the command-hook subsystem.

## Enable and inspect

Hooks are on in every main session; no startup flag enables or disables them. Each source keeps its own profile: `.claude` files use the Claude profile, `.codex` files and Codex TOML use the Codex profile, and Octocode files (`<Octocode home>/hooks.json`, `.octocode/hooks.json`) use the native contract. The Claude and Codex profiles are partial compatibility layers, not full host support; the sections below state what each implements.

An agent sees which hooks may act on its calls in the `hooks` section of its prompt: one line per event and tool matcher, never a command, URL or prompt. The section follows the loaded configuration and is absent without a hook.

Execution still requires valid configuration, folder trust for project files (`/trust`); plugin hooks load once the plugin is added or enabled (see [plugins](plugins.md)). To turn all hooks off, set `"disableAllHooks": true` in any loaded hook file; see [Discovery](#discovery). To turn off one host's hooks, one file or one hook without editing it, use `/harness` (the `toggles` setting); see [plugins](plugins.md#inspect-and-switch-plugins-extensions-and-hooks). The [Claude permission rules](permissions.md#claude-permission-rules) from the same settings files also always apply. Native extensions and skill discovery have their own loaders.

Run `/harness hooks` to inspect loaded commands, source files, timing (runs, failed runs such as a timeout, a crash or an `mcp_tool` call to a missing server, average and maximum) and configuration diagnostics. The startup Hooks row counts files that define at least one hook. Each loaded command shows its source dialect and runtime profile. `/harness hooks events` lists every implemented event and the handler types each profile accepts there. Both are inspection only: switch hooks with `/harness enable` and `/harness disable`.

Project hooks load only when `/trust` (or `octocode trust add`) trusts the folder. That trust is per folder: `/trust` does not list a project's hook commands, URLs or the environment variables they would send, and it does not fingerprint the hook files, so a trusted project's later edits to them load without a new review. Read a project's hook files before trusting the folder, and check `/harness hooks` afterwards; HTTP handlers show their host there (see [Claude HTTP preview](#claude-http-preview)). After editing user hook files, use `/reload` or restart.

Subagents run hooks only when their profile declares `hooks: true`.

### Source profiles

The upstream profiles reject Octocode-specific message events, and the Codex profile rejects Notification. The profiles separate command identity and timing by protocol, applies source-specific matcher rules, ignores Stop matchers for upstream profiles, uses the current Claude/Codex 600-second default command timeout, and reports unsupported Codex PreToolUse `ask`, `decision: approve`, `continue`, `stopReason` and `suppressOutput` as hook failures. The local `failClosed` extension still denies on those failures when configured. The Claude profile also accepts `args` and `onFailure`; the Codex profile accepts `commandWindows` (selected only on Windows). An `args` array, including an empty array, selects direct executable spawning without shell tokenization. Each argument stays literal except supported `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` path substitutions when those variables are available. Reviewed plugin hooks receive root/data variables as described in [plugins](plugins.md). Arguments are part of invocation identity, so different argv invocations cannot erase each other during deduplication.

Claude `onFailure: "block"` denies failed pre-tool hooks; `"continue"` retains fail-open behavior unless native `failClosed` is also set. Failed PostToolUse hooks with `"block"` add feedback after execution. Stop failure never forces continuation. Source-profile PreCompact blocks cancel through the existing compaction owner; Claude failure policies also apply there. Native/default PreCompact remains observational. The hook adapter forwards the compaction cancellation signal to its processes. Windows execution and full session-level compaction conformance have not been validated.

Explicit timeout capping, tool payloads, other lifecycle timing and remaining result semantics are still governed by the limitations below.

Claude simple matchers support exact names separated by `|` or `,`; patterns containing other characters use unanchored JavaScript regexes. Codex matchers use unanchored regexes. Native matchers retain whole-name matching. Identical command text from different profiles runs separately; duplicates within a profile merge. Review the sources shown by `/harness hooks` when the same script is configured for several hosts.

### Claude asynchronous command preview

Claude-profile command handlers can set `async: true` to start without delaying the event. They receive the same input as synchronous handlers. Blocking decisions, input rewrites and `continue` in their output cannot control the completed event. An explicit command timeout is not enforced for these background handlers, following the [Claude async contract](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background).

After successful completion, string-valued `systemMessage` and `hookSpecificOutput.additionalContext` become hidden context once, at the next prompt or a naturally continuing tool boundary. Completion does not start another model turn. The response can be a JSON object alone on stdout, including pretty-printed JSON, or the last JSON object on its own line among log lines. Incorrectly typed context fields are dropped. Captured output is limited to 64 KiB and pending context to 16 KiB, using the existing context spill mechanism.

`asyncRewake: true` also runs in the background, but retains its configured timeout even when `async` is set. Exit code 2 queues a hidden follow-up and can wake an idle agent; stderr takes precedence over stdout. Successful JSON context still waits for a natural prompt or tool boundary. Background execution timing appears in `/harness hooks` without warnings claiming the foreground waited for it.

Session replacement and shutdown cancel running background processes and discard undelivered context. An already-cancelled invocation cannot start a new process, and an already-cancelled prompt does not consume pending context. Notification observers also stop with their session while remaining independent of foreground cancellation. This preview does not implement asynchronous `SessionEnd`, verbose completion notices or upstream diagnostic messages for dropped fields. Native handlers reject both async fields. Codex accepts `async` with the distinct behavior below and rejects `asyncRewake`.

### Codex asynchronous command preview

Codex command handlers accept `async: true`. At most eight background commands execute per session; further commands queue until a slot opens. Timeouts apply, and `SessionEnd` always executes synchronously. Successful output must satisfy the same event-specific validation as synchronous Codex output. Additional context waits for a natural prompt or continuing tool boundary; system messages appear as warnings. Background decisions, rewrites and Stop feedback cannot change the completed event or wake the agent. Session shutdown cancels running commands and discards queued work and pending context. The local capture and context limits above still apply. See the [Codex background contract](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background).

### Codex context limits

Codex command hooks accept `additionalContextLimit` as a non-negative integer for PreToolUse, PostToolUse, SessionStart, SubagentStart and UserPromptSubmit. The default is 2,500 approximate tokens, counted as four UTF-8 bytes per token. Zero disables per-handler spilling. Other events diagnose and ignore this setting; malformed limits reject the handler. Different limits remain distinct during command selection.

Context over the handler's limit is saved to an owner-only file in Octocode's existing session output directory. The delivered text contains a Unicode-safe head/tail preview and the saved path. Both foreground and background delivery use this policy. Octocode still applies its independent 16 KiB aggregate delivery limit and 64 KiB process-output capture limit, including when the per-handler value is zero. File locations, aggregate limits and oversized process-output capture therefore remain local differences from the [Codex large-output contract](https://learn.chatgpt.com/docs/hooks#large-hook-output).

### MCP tool preview

Both source profiles accept `mcp_tool` handlers targeting servers registered with the existing MCP owner. Calls do not dispatch hooks again, but Octocode's permission gate decides them like a model's MCP call, except from a `PermissionRequest` hook (see [Hook-initiated MCP calls](permissions.md#hook-initiated-mcp-calls)). Codex requires an existing connection, attempts startup callbacks without waiting for servers, and excludes `SessionEnd`. Its whole-value placeholders preserve JSON types, embedded placeholders become text, and missing fields fail the callback before invoking a tool. Claude retains string substitution and skips startup/resume/fork callbacks; clear and compact callbacks can run.

Errors remain hook failures; explicit supported decisions use the profile's output decoder. Calls use the shorter server or hook deadline. The local hook deadline currently includes time spent in MCP elicitation; Codex excludes that time upstream, so this transport remains partial. Sessions load the built-in MCP owner; with MCP disabled (`--no-mcp`) the bridge has no owner. The separately owned automatic Octocode research server is not exposed through this bridge. See the [Codex MCP contract](https://learn.chatgpt.com/docs/hooks#mcp-tool-hooks).

### Claude HTTP preview

Claude-profile `type: "http"` handlers run for the supported events except SessionStart. They POST the event JSON and use the existing decision decoder. Header environment interpolation requires the handler's `allowedEnvVars`; trusted Claude settings can further restrict it with `httpHookAllowedEnvVars`.

**Destinations.** A handler's `url` must be `https`; plain `http` is accepted only for a loopback host (`localhost`, `127.0.0.0/8`, `::1`), because bearer tokens in headers and the payload would otherwise cross the network in clear text. Octocode resolves the host first, refuses the request when any resolved address is link-local (`169.254.0.0/16`, `fe80::/10`) or a cloud metadata address (for example `169.254.169.254`, `fd00:ec2::254`), and connects only to the addresses it checked, so a name that points at the metadata service or changes its answer is refused too. The refusal is a hook failure with a one-line reason and applies even to a host the allowlist names. Loopback and private ranges stay reachable for local development servers; set `allowedHttpHookUrls` to restrict a machine further.

**Allowlist scope.** `allowedHttpHookUrls` (`*` wildcard patterns) and `httpHookAllowedEnvVars` come from user settings, whose lists merge; an empty list permits nothing. A trusted project's settings can only narrow them: a URL or variable must match the user list and every project list, so a project `*` or an extra project entry never widens what the user allowed. When the user sets no list, a trusted project list is the only restriction and still only removes destinations from the unrestricted default (an untrusted project's settings are not loaded at all).

**What the host receives.** The full event payload (for example the tool name and input, prompt text and working directory) goes to the allowed host, as with Claude; allow only hosts you would hand that data. Header values expanded from `allowedEnvVars` go there too.

**What it may answer.** Output parity with Claude is kept: an HTTP handler can block, allow a permission request, rewrite tool input and add context, on the authority of the configuration you or a trusted project wrote. The text it returns (`additionalContext` and a continuation reason) reaches the model inside the untrusted-data fence, headed `External data from HTTP hook <host>`, so the model treats it as data to evaluate. An allow or an input rewrite from an HTTP handler is recorded in the permission audit with the handler's host (never its path or query).

Responses must be empty or JSON objects with a successful status. Transport errors, invalid responses, and timeouts follow `onFailure`. Responses are limited to 64 KiB and redirects are rejected. An unparseable body fails with the fixed message `HTTP response is not valid JSON`, never the body text, and failure text is passed through secret redaction before it is shown or audited. These limits and redirect behavior are local compatibility constraints. Configuration diagnostics appear in `/harness hooks`; the inspector hides HTTP URL paths and headers. Invalid URLs retain their failure policy: a required gate denies matching calls without sending a request. HTTP handlers run only for Claude sources, not native or Codex sources. See the [upstream HTTP contract](https://code.claude.com/docs/en/hooks#http-hook-fields) and [allowlist policy](https://code.claude.com/docs/en/settings-reference#allowedhttphookurls).

### Claude prompt evaluation preview

Claude `type: "prompt"` handlers run a single model evaluation for PermissionRequest, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop and UserPromptSubmit. Set a non-empty `prompt`; `$ARGUMENTS` inserts the event JSON once, while an escaped placeholder stays literal. If no placeholder consumes the input, the JSON is appended. The evaluator has no tools and uses the existing model registry for authentication and routing. A timeout defaults to 30 seconds and cancels evaluation; responses are limited to 64 KiB and 1,024 generated tokens locally.

An explicit `model` selects a unique registered model ID or `provider/model-id`. Missing or ambiguous models produce hook failures. Without `model`, this preview uses the current session model, which differs from Claude Code's background-model default. Evaluations can incur provider usage. No claim is made that different models produce equivalent judgments.

The response must be JSON with boolean `ok`; `ok: false` requires a non-empty `reason`. PreToolUse denies the call and ends the turn unless `continueOnBlock: true`. PostToolUse ends the turn by default, or adds feedback and continues when that flag is true. PostToolUseFailure adds feedback without ending the turn. PostToolBatch and UserPromptSubmit block their boundary. Stop and SubagentStop feed the reason into a continuation unless `impossible: true`, which allows stopping. Existing Stop-loop limits still apply. PermissionRequest prompt results are observational: `ok: false` does not deny an approval, and its `reason` is shown as a warning (once per hook and reason). Evaluation errors, including a response without boolean `ok`, follow the existing hook failure policy, including the local `failClosed` extension on supported gates.

This preview does not implement agent verifiers, unsupported event families, hook-local tool conditions, spinner text, upstream model aliases or live model-equivalence evaluation. See the [Claude prompt-hook contract](https://code.claude.com/docs/en/hooks#prompt-based-hooks).

Claude settings and plugin hook files accept a boolean `once` and ignore it, as the upstream settings contract requires. It does not remove a handler after execution. Claude honors `once` only for skill-scoped hooks, which Octocode does not yet activate. Codex and native profiles continue to reject this field.

### Permission-request preview

`PermissionRequest` runs when a tool needs an unresolved approval, before a dialog, child relay or headless refusal. Automatic mode and existing grants bypass this event unless an explicit source ask still needs approval; see [source permission rules](permissions.md). It also covers native file and network checks inside tool execution. The event receives the actual active invocation; tool-less requests and expired or mismatched tool contexts stay on the native permission path. Both profiles omit `tool_use_id` for this event.

Return `hookSpecificOutput: {"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}` to approve this request, or use `"behavior":"deny"` with an optional `message`. An allow lasts for this request; it does not create a session grant. Within each projected Claude request, the first effective allow or deny wins; slower handlers are cancelled and their cleanup finishes before execution. A handler with no decision does not win. Codex handlers and decisions across profiles retain deny precedence. Claude denial can also set `interrupt: true`: the refusal is audited before the turn stops. The audit entry keeps a denial `message` folded to one line (line breaks shown as `⏎`), with secrets redacted and each part clipped. Claude universal `continue: false` also stops the turn and takes precedence over a nested allow; `stopReason` is retained. Codex rejects that field when true. Codex exit 2 denies only with a nonempty stderr reason; Claude exit 2 without a decision leaves the approval unresolved. Invalid output is diagnosed and contributes no decision, so a valid sibling allow may still apply. The local `failClosed` option and supported Claude `onFailure: "block"` explicitly deny on failure.

Native file batches require an allowance for every projected Claude query. Matching source hooks whose file input cannot be represented cause refusal; another profile's allow cannot override that adapter limitation. Cancellation and an invocation expiring while hooks run prevent a late allowance. Source hooks cannot undo invariant refusals that occur before the approval boundary.

Claude `updatedInput` is supported at the outer permission gate for agent Bash calls. The replacement is validated, current source policy and reservations are checked again, and the arguments change only while the invocation remains active. The original command does not execute. A replacement that matches a source ask, trips the provenance check or follows a hook ask cannot inherit the original hook approval; it needs a person, and an unresolved headless request is refused. An empty object preserves the input but still rechecks those rules. No second PermissionRequest hook is dispatched.

Native `file` query batches support indexed Claude Write/Edit/MultiEdit replacements before execution. Every projected query must be approved. The file owner validates original read and edit requirements before hooks, collects replacements without writing, then validates the complete effective batch against source policy, read coverage, edit anchors, reservations and protected state. Approval previews show the effective queries. Canonical target identities are checked again after approval and inside the existing file mutation lock. Claude post-tool inputs and supported Codex patch snapshots reflect the committed batch.

An empty replacement preserves that query but rechecks its source ask. Untouched siblings retain their original approval; settings changes invalidate pending approval. Unknown source fields are ignored, and `replace_all: false` retains exact-once editing. `replace_all: true` maps to native `edits[].replaceAll`: it replaces non-overlapping occurrences against the original file, preferring exact matches and using smart-quote matching only when no exact match exists. It preserves line endings and does not expand partial-read coverage. Combining replace-all with another edit that needs broader fuzzy matching is currently refused. Canonical patch replacements and overlapping rewritten targets remain unsupported. Unchanged native batches keep sequential create/edit behavior. Staging prevents writes before candidate validation; it does not roll back earlier writes if a later execution fails. The existing local Delete projection is an Octocode extension, not a Claude tool.

Replacement during other internal checks, typed shell commands or PowerShell invocations remains unsupported and refuses the call. Session-destination `addRules`, `replaceRules` and `removeRules` updates now pass initial runtime checks. They apply in order to future calls after the current input is approved; invalid replacement inputs do not retain them. An empty array is a no-op. Persistent destinations, mode changes and directory updates remain unsupported while their source-policy transaction is implemented. In an untrusted project, a persistent update to `projectSettings` or `localSettings` that would grant (an allow rule, `acceptEdits` or extra directories) is refused before any file is written, because that project's files grant nothing; the call is not executed and the message names `/trust` and the `userSettings` and `session` destinations. A restricting update (deny or ask rule, removal) is still written; see [Claude permission rules](permissions.md#claude-permission-rules). Full verification of permission updates remains in progress. This event remains partial. The separate [permission-rule preview](permissions.md) enforces a partial Claude rule set. Host permission suggestions, complete MCP metadata, full source permission modes/rules and the Claude SDK permission-host race remain unverified. Prompt evaluations cannot make this event's decision, and agent verifiers are not implemented. [How compatibility is checked](../../../docs/PLUGINS_MODS_HOOKS.md#how-compatibility-is-checked) lists the replays.

### Failed-tool preview

Claude PostToolUseFailure receives top-level tool errors and can add recovery context without replacing the error. Partial file-batch failures are not yet classified separately from denied or skipped queries; that part of the lifecycle contract remains open.

## Quick start

Save this configuration in `<repository-root>/.octocode/hooks.json`:

```json
{
	"hooks": {
		"SessionStart": [
			{
				"matcher": "startup",
				"hooks": [
					{
						"type": "command",
						"command": "node -e \"console.log('Project hooks are active')\"",
						"timeout": 5
					}
				]
			}
		]
	}
}
```

Start with hooks enabled, trust the folder, and inspect `/harness hooks`. The command's stdout becomes hidden model context on the next prompt, not a terminal notification. The example requires Node on PATH. Its exact JSON and command are exercised by [the discovery tests](../test/octocode/hooks-discovery.test.ts).

## Discovery

Claude Code (`~/.claude/settings.json`, project `.claude/settings.json` and `.claude/settings.local.json`) and Codex (`$CODEX_HOME/hooks.json`, `config.toml` `[hooks]`, project `.codex/hooks.json` and `.codex/config.toml`) hooks load only while that harness is on in `/harness`; both are off by default. A harness switched off is not a warning: `/harness hooks` and the startup Harness line count its hooks as off. Cursor has no hook format Octocode reads.

Events each profile implements (`/harness hooks events` prints the handler types too):

| Event                                                                                       | Native | Claude | Codex |
| ------------------------------------------------------------------------------------------- | ------ | ------ | ----- |
| PreToolUse (gate), PostToolUse, SessionStart, SessionEnd, PreCompact, Stop                  | yes    | yes    | yes   |
| PermissionRequest (gate), UserPromptSubmit (gate), SubagentStart, SubagentStop, PostCompact | no     | yes    | yes   |
| PostToolUseFailure, PostToolBatch, StopFailure                                              | no     | yes    | no    |
| Notification                                                                                | yes    | yes    | no    |
| Interrupt                                                                                   | no     | no     | yes   |
| AgentOn, AgentOff, PreMessageSend (gate), PostMessageReceive                                | yes    | no     | no    |

Other upstream events (for example Claude's Setup, ConfigChange or FileChanged, Codex's PreModelRequest) are reported as not implemented.

Octocode reads these files in order when the session starts:

| Order | Scope           | Location                                        |
| ----- | --------------- | ----------------------------------------------- |
| 1     | User            | `~/.claude/settings.json`                       |
| 2     | User            | `~/.codex/hooks.json`                           |
| 3     | User            | `<Octocode home>/hooks.json`                    |
| 4     | Trusted project | `<repository-root>/.claude/settings.json`       |
| 5     | Trusted project | `<repository-root>/.claude/settings.local.json` |
| 6     | Trusted project | `<repository-root>/.codex/hooks.json`           |
| 7     | Trusted project | `<repository-root>/.octocode/hooks.json`        |

Octocode home defaults to `~/.octocode/octocodecode/`; `OCTOCODE_HOME` overrides it. `OCTOCODE_CODING_AGENT_DIR` changes core configuration, not this native hook path. A non-empty `CODEX_HOME` relocates Codex user JSON and TOML discovery to that existing directory. An invalid override reports a diagnostic and skips Codex user sources without falling back; project paths remain unchanged. This local diagnostic differs from Codex aborting startup for an invalid home. Project paths use the repository root even when the session starts in a subdirectory.

Missing files are normal. Unreadable files, invalid JSON and malformed hook containers produce diagnostics. Supported entries are merged, not replaced by the last file. Within one profile, identical command strings selected for one dispatch run once; the first timeout/source is retained, while required denial is preserved across duplicates. Configured plugins can contribute reviewed hooks; see [plugin configuration](plugins.md#configure-a-local-plugin). There is no general recursive script search. Discovery also reads `~/.codex/config.toml` and trusted `<repository-root>/.codex/config.toml`, each immediately after its `hooks.json`. Inline hooks and JSON hooks merge with a diagnostic when both declare hooks in the same directory. TOML accepts `command_windows` or `commandWindows`; JSON accepts only `commandWindows`. `[features] hooks = false` disables Codex-profile hooks, including plugin hooks; `codex_hooks` is a deprecated alias. A trusted project value overrides the user value. Other Codex configuration, profile selection and managed requirements are not imported. Invalid TOML is reported without parser snippets that could expose settings values.

`CLAUDE_CONFIG_DIR` selects the directory containing user `settings.json`. It does not change project locations or load the default user file as a fallback. Use an absolute path; Octocode resolves relative values from its process working directory without shell or tilde expansion. Skill discovery uses the same Claude directory resolver.

Any loaded file with `disableAllHooks: true` disables all loaded hooks, including required gates. A later `false` does not override it. This is Octocode's conservative switch, not Claude settings precedence. An untrusted project cannot supply this switch because its files are not loaded. `/harness hooks` can report the subsystem enabled with zero loaded commands and a disable diagnostic.

## Supported contract

[Hook events](hook-events.md) lists every implemented event with the handler types, timeouts and input fields each profile accepts, plus the upstream events Octocode does not implement yet. That page is generated from the hook catalog; `/hooks events` shows the same table in a session.

Matcher groups accept `matcher` and `hooks`. In the native profile, matchers use whole-name regular expressions; an absent/empty matcher or `*` matches all. Invalid patterns match nothing and produce diagnostics. Tool aliases support common names such as `Bash` and `Edit|Write`; matching an alias does not guarantee a full upstream payload translation.

Command entries accept `type`, `command`, `timeout` and `failClosed`. `statusMessage` is tolerated as presentation metadata but does not replace Octocode's own display. Timeouts are in seconds, default to 60 in the native profile, and are capped at 600. The Claude and Codex profiles use 600 by default for most command hooks, with the prompt and termination exceptions below. Commands run through the shell in the session working directory. `CLAUDE_PROJECT_DIR` points to the repository root; use it when a script path must work from subdirectories. Reviewed plugin handlers receive their plugin-root/data variables; standalone handlers have no plugin identity.

Supported results include exit code 2 with a stderr reason, JSON denial/block decisions, pre-tool/message approval requests and event-specific context. As in Claude Code, a Claude-profile command hook that exits with a code other than 0 or 2 and prints a JSON object is decided by that object's fields, so a deny printed with exit 1 still denies; a hook with `onFailure: "block"` or `failClosed`, or one that timed out, still counts that exit as a failure (`claudeJsonRun` in `src/octocode/hooks/runner.ts`). A hook's `allow` does not bypass Octocode permissions. Pre/post tool payloads include `tool_use_id`; file queries share their parent call ID.

Prompt and HTTP handlers are available in the Claude profile; configured-server MCP handlers are available in both upstream profiles; agent handlers remain unsupported. The native profile rejects command fields such as `args`, `if`, `async` and `command_windows` rather than discarding them. The upstream-profile exceptions are described above; inline TOML spelling `command_windows` is still not accepted in JSON. Unsupported events and fields are reported. A required hook (`failClosed: true`, or Claude `onFailure: "block"`) with invalid handler configuration retains a blocking diagnostic for supported pre-tool, pre-message and user-prompt gates. This includes empty commands and unsupported handler types. Malformed groups, invalid regexes and unsupported event names cannot establish a gate; inspect diagnostics rather than assuming every invalid configuration enforces policy.

Source profiles support validated generic argument rewrites, Claude file-query rewrites and Codex command-only Bash rewrites. Codex supports the canonical patch mode described in this guide, with explicit projection and path limits. Complete upstream output validation and unchanged Claude Mods execution remain unfinished. Codex output validation covers the eleven events listed in the output audit below; other profiles can still ignore unrecognized fields. See the [design and remaining work](../../../docs/PLUGINS_MODS_HOOKS.md).

Source-profile input includes the active registered model ID when available: Claude receives it on `SessionStart`; Codex receives it on `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, `SubagentStart`, `SubagentStop` and `Interrupt`. Codex receives `null` when no transcript file exists. Source profiles omit the internal `pi_tool_name` field. Existing transcript files still use Octocode's format.

Native composition supplies live permission metadata: `full` maps to `bypassPermissions`; `manual` and `workspace` map to `default`. These are coarse adapter labels, not equivalent vendor policies: native `workspace` permits shell actions and is not Claude `acceptEdits`. This label does not grant permission or bypass native checks. Codex SessionEnd, PreCompact and PostCompact omit permission metadata, following their event schemas.

Codex receives `turn_id` on PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, PostCompact, Stop, SubagentStart, SubagentStop and Interrupt during an active run. The session keeps this identity through tool iterations, steering, retry, automatic compaction and Stop continuation; a selected follow-up batch starts a new identity. An idle manual compaction has no active turn ID and remains a compatibility gap. Native-profile input remains unchanged.

## Interrupted turns

In the Codex profile, `Interrupt` runs once after an explicit interruption cancels active work and saves its pending records. It receives the interrupted session, logical turn, model, live permission label and nullable transcript path. Successful completion, provider failure, idle abort, session replacement, shutdown and internal hook termination do not trigger it. Native children do not emit this main-session event.

Matchers are ignored. The default timeout is one second; non-negative integer timeouts are clamped to one through three seconds. Command handlers can run asynchronously; configured-server MCP handlers are also accepted. Dispatch uses a fresh bounded cleanup signal because the provider's signal has already been cancelled.

Output is observational: empty stdout or a JSON object containing only optional `systemMessage` is accepted. The message is shown as a notification. Plain text, invalid fields and handler failures produce diagnostics. No output injects context, reverses cancellation or starts another model request. Asynchronous messages can arrive after settlement.

## Claude and Codex compatibility audit

Checked against the official [Claude reference](https://code.claude.com/docs/en/hooks) and [Codex reference](https://learn.chatgpt.com/docs/hooks) on 2026-10-22. The implementation trace is [configuration and translation](../src/octocode/hooks/config.ts) → [process and output interpretation](../src/octocode/hooks/runner.ts) → [event dispatch](../src/octocode/hooks/register.ts). This dated audit records the shared adapter that Claude and Codex files used before their profiles became the only behavior on 2026-10-29. That adapter remains the native profile for Octocode hook files, so the table now describes `.octocode/hooks.json` and `<Octocode home>/hooks.json`; Claude and Codex files follow the profile sections above.

Upstream differences that matter: Codex defaults most command timeouts to 600 seconds, supports inline TOML, emits `apply_patch` with patch text, includes model/turn metadata, and gives explicit Stop termination priority across hooks. Its PreCompact hook can stop compaction. Claude supports additional handler transports, input rewriting and common permission metadata. Neither host's whole contract is implemented here; use the following local behavior when deciding whether a script can migrate.

| Boundary               | Octocode behavior                                                                                                                             | Migration consequence                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON configuration     | Accepts nested event → matcher group → command handler; ignores unrelated top-level settings                                                  | Basic command entries can migrate. Successful parsing alone does not prove semantic compatibility.                                                      |
| Discovery and trust    | Only the seven paths above; folder trust (no per-file approval)                                                                               | No managed-policy, plugin manifest, skill-frontmatter or inline TOML import. Host trust decisions are not imported.                                     |
| Command fields         | `type`, `command`, `timeout`, `failClosed`; `statusMessage` accepted but not displayed                                                        | `commandWindows`, `command_windows`, `additionalContextLimit`, `async`, `if`, `args`, `shell` and other handler fields reject the entry.                |
| Timeouts               | Default 60 seconds; maximum 600                                                                                                               | Set an explicit supported timeout when migrating.                                                                                                       |
| Matchers               | Whole-name JavaScript regex; aliases also match                                                                                               | Partial/unanchored patterns are not portable. A nonempty Stop matcher matches no names and prevents execution; omit it.                                 |
| Common input           | `session_id`, `transcript_path`, `cwd`, `hook_event_name`                                                                                     | No `permission_mode`, `model`, `turn_id`, prompt or agent metadata. Missing transcript is an empty string; an existing transcript is Octocode's format. |
| Shell input            | Native `bash` becomes `Bash`; input is otherwise retained                                                                                     | Check every field used by the script, not just `tool_input.command`.                                                                                    |
| File input             | Native `file` becomes one Edit/Write/MultiEdit/Delete dispatch per query                                                                      | No Codex `apply_patch` input or patch-text conversion. `Delete` is a local alias. All queries retain the parent `tool_use_id`.                          |
| Other tool input       | Matching aliases can exist while payload retains its native name and arguments                                                                | A matched name is not a translated schema. Legacy `edit`/`write`/`read` rename `path` only; other fields retain their native spelling.                  |
| Successful tool output | `tool_response` is flattened text; partial file batches dispatch only successful queries                                                      | Scripts expecting a structured result or exit-code field need adaptation.                                                                               |
| Gate decisions         | Denial and `ask` supported (in the default `full` mode a hook `ask` runs without a dialog and is recorded); `allow` cannot bypass permissions | `updatedInput` is ignored. No input mutation or permission-policy replacement.                                                                          |
| Common output          | `systemMessage` and `suppressOutput` ignored; `hookEventName` is not validated                                                                | Missing or mismatched event tags do not reject results. Unknown JSON fields can be silently ignored.                                                    |
| `continue: false`      | Stops Stop continuation; on PreToolUse it blocks that call; SessionStart/PreCompact dispatchers discard the block                             | No general whole-turn stop contract. In particular, PreCompact cannot veto compaction.                                                                  |
| Stop aggregation       | Explicit `continue: false` wins over `decision: "block"`, within one output or across commands                                                | Fixed in this audit; exit 2 and block decisions otherwise request continuation, subject to the existing loop cap.                                       |
| Session start source   | Startup/reload → `startup`; new → `clear`; resume → `resume`; fork → `fork` (the native profile keeps `resume`); compaction → `compact`       | Claude and Codex hooks matching `fork` run for an Octocode fork.                                                                                        |
| Start context          | Delivered as hidden data on a following prompt; waiting is bounded                                                                            | Do not assume upstream developer-message priority or identical delivery timing after compaction.                                                        |
| Environment            | Adds `CLAUDE_PROJECT_DIR`; inherits the launching process environment                                                                         | Does not provision plugin root/data directories or a `CLAUDE_ENV_FILE` persistence mechanism.                                                           |
| Extensions and mods    | Native TypeScript extension API and Octocode package resources                                                                                | Claude Mods and Claude/Codex plugin APIs are not interchangeable with this runtime.                                                                     |

The native profile accepts only the events marked for it in [Hook events](hook-events.md); the parser reports the others. That table is the complete allowlist, not a sample. `PreMessageSend` and `PostMessageReceive` are Octocode-specific.

**Porting check:** review `/harness hooks` diagnostics, inspect the actual input consumed by each script, choose an explicit timeout, and exercise allow/deny/error/timeout outcomes before relying on a gate. Use only the documented rewrite and plugin adapters; unsupported reverse translations deny the rewritten call rather than executing an unsanitized input. Verify the resulting tool input and permission decision in a fixture before migrating a policy.

The regression suite checks Stop termination in both command orders and in a single conflicting response, alongside discovery, denial, approval, context, failure and cancellation tests. These are local contract tests. Eleven isolated Claude Code 2.1.309 permission cases and pinned Codex parser comparisons provide narrow differential evidence, recorded in the matrix; neither complete upstream CLI/session contract has passed conformance. Future host adapters need pinned fixtures for discovery, input, output and aggregation before advertising full compatibility.

## Failures and troubleshooting

Hooks execute with the launching user's privileges. They are not sandboxed. The runner limits captured output, sanitizes displayed context and terminates process trees on cancellation/timeout.

Pre-tool/message hooks normally fail open after a crash, timeout or malformed JSON result. Set `failClosed: true` on a required gate command to deny on those failures. Failures are audited; UI warnings are shown once per hook. Required command-configuration errors also deny matching calls. This does not turn arbitrary malformed configuration into a blocking policy.

If a hook does not run, check `/harness hooks` in this order: startup enablement, discovered path, folder trust, disable diagnostics, event/type/field support, matcher, and command availability. Configuration changes take effect on reload/session start, not through a file watcher. Do not remove safety checks just to make an unsupported configuration execute.

#### Prompt submission in the source profiles

Claude `UserPromptSubmit` runs at admission before skill/template expansion. Codex runs when initial, steering or follow-up input is selected for processing, before its message is recorded and before Codex mention skills are read. Enqueueing alone does not run the Codex hook. Local slash-command and template expansion still happen at admission. Claude receives the text available at its position in the admission handler chain; Codex receives the request after that chain completes. Both expose it as `prompt` and ignore the matcher. Exit 2 or a JSON blocking verdict prevents submission. Claude `onFailure: "block"` also blocks on execution/configuration failure.

Successful plain stdout or `hookSpecificOutput.additionalContext` is delivered as hidden context. Claude discards context from rejected input; Codex retains it. In a Codex batch, accepted messages proceed while blocked messages are omitted. If input was blocked and no user item was accepted, processing settles without another provider request or a Stop hook for that blocked input. Cancelled input does not deliver context or read mention skills. Extension calls that submit user messages remain gated even with template expansion disabled; injected custom context does not recursively invoke input hooks.

Claude's default timeout for this event is 30 seconds; Codex's is 600 seconds. The Codex profile supplies the active logical turn ID. Exact upstream context roles and ordering remain different. Context is delivered before later model/authentication validation and other extensions may still reject the input. Immediately handled extension slash commands do not emit this event. `SessionEnd` and `PostCompact` are available in the preview as described below.

#### Post-compaction in the source profiles

Claude and Codex `PostCompact` commands run after the summary is saved, with `trigger` (`manual` or `auto`) and `compact_summary`. Claude treats this event as observational. Codex `continue: false` stops the current operation after successful compaction; automatic retry and queued-work continuation do not proceed. A later explicit operation may still consume queued messages. Native configurations continue to reject this event.

Claude PreCompact ignores `continue`; use `decision: "block"` or exit 2 to veto compaction. Codex retains its separate `continue: false` behavior. Exact upstream metadata and context ordering remain outside the verified preview contract.

#### Child lifecycle in the source profiles

SubagentStart and SubagentStop run inside an opted-in native child. The parent must enable hooks and the child profile must set `hooks: true`. Both events match the native profile name, such as `general`, rather than inventing a vendor role name. Main source-profile SessionStart and Stop are not also dispatched for the child; native lifecycle hooks retain their behavior.

Codex SubagentStart runs for a new or forked child, before its first provider request, and does not run when reopening its saved session. Claude SubagentStart also runs on subsequent child prompts. Start context belongs to the child and cannot veto child creation. Claude suppresses identical startup context while its earlier copy remains in the active context; after compaction removes that copy, it can be inserted again.

SubagentStop runs at successful child settlement. A blocking reason continues the child through its existing loop, with `stop_hook_active` and the eight-continuation cap; a tool call resets the cap. Cancellation and provider failure do not emit successful SubagentStop. Claude can also return additional context as continuation feedback. Codex validates its distinct output schema, which has no nested additional-context field.

Claude receives the parent session identity and transcript, plus the native child's agent identity. Codex receives the actual child session ID, active turn ID and model. For both profiles, SubagentStop uses the parent `transcript_path` and child `agent_transcript_path`. Missing Codex transcript paths are null. These files remain Octocode transcripts. Standalone registrations without required live metadata skip the callback with a diagnostic.

Ordinary source callbacks inside an opted-in child also receive `agent_id` and `agent_type`. Codex includes them on PreToolUse, PostToolUse, UserPromptSubmit, PreCompact and PostCompact; Claude uses its common child fields. Codex identifies the actual child session; Claude uses the same native agent identity as its child lifecycle hooks. Main sessions omit these fields even when stale agent-name variables exist. Native-profile payloads are unchanged.

Ordinary callbacks retain the child process's current `session_id` and transcript path. Lifecycle callbacks retain the parent/child routing above; this process adapter does not claim Claude's full in-process agent context. Dispatch captures model, turn, permission and child metadata before queuing an asynchronous command, so later state changes cannot relabel an earlier event. Input/tool/resume behavior has actual-child process coverage; child compaction fields have hook-owner tests, without a separate live child-compaction conformance run.

Vendor internal agents, vendor transcript formats, parent background-task inventories and complete vendor-specific agent metadata remain outside this adapter. Native profile names, child hook opt-in and local continuation/context limits remain migration differences.

#### Session termination in the source profiles

Native, Claude-format and plugin `SessionEnd` hooks run for session replacement or quit: new sessions map to `clear`, resume to `resume`, and other termination to `other`. Runtime reload does not emit SessionEnd. Codex emits it only for main-session quit with `reason: "other"`; switching sessions and subagent shutdown do not emit it. Octocode does not provide the vendor's idle/archive service events.

SessionEnd is observational. Native and Claude hooks default to 1.5 seconds per command. The shared budget follows the largest configured native, Claude-format or plugin hook timeout, capped at 60 seconds, unless `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides it. That override also supplies the default per-command timeout. Codex defaults to one second and caps explicit timeouts at three seconds. Cleanup uses a fresh shutdown cancellation scope, so an already-aborted turn does not suppress it.

#### Agent presence in the Octocode profile

`AgentOn` and `AgentOff` are Octocode's own events: Claude and Codex have no counterpart, and the `SubagentStart` and `SubagentStop` events of those profiles are unchanged. They are observers: output is ignored, they cannot block or add context, and a `failClosed` setting has no effect. A hook runs in the process that wrote the transition to the team database, once: an agent's own process for its join and its leave, and the parent (or another process) that finds a child dead and retires its row, so a killed child still gets an `AgentOff` with reason `crashed` from the process that reaped it. A process that is killed runs no hook of its own. Only sessions that are persisted to a session file write these transitions; a session without one runs neither event.

`AgentOn` fires when the agent joins the team (a main session when it starts, a child when it starts); its matcher is the agent's role (`main` for a main session). `AgentOff` fires when the row is retired; its matcher is the end reason: `completed`, `failed`, `stopped-user`, `stopped-parent`, `parent-gone`, `crashed` or `left` (an older stored `reaped` reads as `crashed`). Both use the `SessionEnd` deadline (1.5 s, raised to the longest configured hook timeout, at most 60 s) and a hook still running then is stopped. Session shutdown waits for the hooks it started.

Input (added to `session_id`, `cwd` and `hook_event_name`):

| Field                                    | Event      | Meaning                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seq`                                    | both       | The transition's sequence in `agent_events`: orders events of one database.                                                                                                                                                                |
| `agent_id`, `agent_type`                 | both       | The agent's name and role.                                                                                                                                                                                                                 |
| `kind`                                   | both       | `main` for an agent without a parent, else `child`.                                                                                                                                                                                        |
| `parent_agent_id`                        | both       | The parent's name, or `null`.                                                                                                                                                                                                              |
| `model`, `goal`                          | both       | The model and one-line goal on the row, or `null`.                                                                                                                                                                                         |
| `pid`                                    | both       | The agent's process.                                                                                                                                                                                                                       |
| `parent_session_id`, `branch`            | both       | The parent's session id and the agent's git branch when it joined, or `null`.                                                                                                                                                              |
| `backlog_item`, `run_id`                 | both       | The backlog item the run was started for (`B36`, or `<workspace name>:B36` from another workspace) and the run's id in `agent_runs`, or `null`.                                                                                            |
| `reason`, `detail`                       | `AgentOff` | The end reason; `detail` is free text when the writer gave one.                                                                                                                                                                            |
| `started_at`, `ended_at`, `duration_ms`  | `AgentOff` | When the agent joined and the transition was written (ISO 8601), and the time between.                                                                                                                                                     |
| `status`, `tool_calls`, `tokens`, `cost` | `AgentOff` | The row's last heartbeat: status, tool calls, `tokens` as `{ input, cache_read, output }` and cost. A number the row never recorded is `null`.                                                                                             |
| `outcome`, `files_changed`               | `AgentOff` | The outcome word (`done`, `partial`, `blocked`, `failed`) when the parent had recorded it when the agent left (usually `null` for a child that leaves before its report), and the files it changed as `{ count, paths }` (first 20 paths). |

The agent's folder is the common `cwd` field of the input.

### Codex post-tool result preview

Codex PostToolUse runs only for successful results. Failed tools, denied calls, invalid rewrites and file batches containing any failed query do not invoke it. This follows the [pinned Codex registry](https://github.com/openai/codex/blob/8eaf5fd115f036d207be236009938261758e30f2/codex-rs/core/src/tools/registry.rs). A blocking decision, exit code 2, or `continue: false` replaces the visible result with hook feedback; original details and structured content are not retained with replacement text. Nested blocking decisions mark the result as an error, while `continue: false` only replaces content. Exact upstream nested-promise rejection remains unverified against the local nested-call API, which returns error outcomes. Non-null `updatedMCPToolOutput` and `suppressOutput: true` produce diagnostics without replacing output.

SessionStart now reports `fork` for Claude and Codex profiles. The native profile retains its existing `resume` mapping on a fork.

### Codex file-patch preview

A supported native `file` batch produces one Codex `apply_patch` input, `{ "command": "*** Begin Patch\n…\n*** End Patch" }`, with the original tool-call ID. `Edit` and `Write` are matcher aliases; the payload name remains `apply_patch`. Native and Claude handlers retain per-query dispatch for native queries. A batch the projection cannot reproduce exactly (an edit of a file without a current verified read, a write without a final newline, two edit queries on one file) runs without its Codex hooks, like a crashed hook: a warning names the skipped hook and the reason, and only a matching hook with `failClosed: true` denies the call instead. A canonical Update/Move patch likewise runs without per-query native and Claude PreToolUse hooks, which cannot see it losslessly, unless one of them is `failClosed`.

The file owner also accepts canonical patch mode, including Add/Delete/Update, Move destinations, context chunks and EOF markers. A valid Codex `updatedInput.command` selects that mode rather than flattening the patch into native queries. The existing file owner prepares all operations before mutation, then executes in order and stops at the first failure. See [file mutation guarantees](native-features.md#canonical-patch-mode).

Final input is validated and passes existing permissions, reservations, unread-file and stale-file checks. Invalid or conflicting source-profile rewrites block without falling back to the original operation. PostToolUse receives the accepted patch captured before execution, including after a delete; it does not reconstruct input from changed files. Failed or partially committed patches do not invoke a successful Codex post-hook.

Native edit queries become `*** Update File` sections with whole-line context. They are built from the file's current bytes only when the file guard still holds a read of it (unchanged since, digest-checked when known): the edits are applied with the `file` tool's own engine (exact-once or `replaceAll` matching, `line` anchors with `sourceSha256`, BOM and line endings), and the section is kept only when applying it reproduces those bytes exactly.

Projection still has limits. Native writes must be empty or LF-only with a trailing newline. An edit is refused when the file was not read in this session, changed or left the context since, is not UTF-8, lacks a final newline, has mixed line endings the edit would normalize, or is changed by more than one query of the batch. A file changed after the pre-hook ran but before the call executes is not re-projected. A matching Codex pre-hook blocks an unrepresentable native call with a diagnostic. A post-only hook cannot prevent execution, so it reports missing projection instead. Calls without matching Codex hooks retain native query behavior.

Direct canonical Update/Move calls with potentially matching native or Claude pre-hooks are refused because exact per-query projection is not implemented. This prevents a move destination from disappearing from a Write gate. Corresponding post-hooks report unavailable projection instead of receiving fabricated Edit payloads. Overlapping targets across separate patch operations, unsupported local path forms and remote environment routing also reject explicitly. These limits keep the adapter partial; the parser/transformer corpus and local session tests do not establish full host equivalence.

### Claude MCP preview

Claude `mcp_tool` handlers can call an existing configured MCP server using `server`, `tool`, and optional `input`. String input values support `${path.to.field}` substitutions from the event payload. Calls use the MCP connection owner without triggering recursive tool hooks or starting an OAuth sign-in flow; the permission gate decides them first ([Hook-initiated MCP calls](permissions.md#hook-initiated-mcp-calls)), and a refused call is a hook error. Decision events wait for an ongoing connection within the hook deadline; observational events require an already-connected server. Missing, disabled, unauthenticated, or failed servers produce hook errors. Error tool results do not become hook decisions.

Cancellation and timeouts stop waiting, and the owner rechecks cancellation before sending the request. Text output uses the shared decision decoder, with a local 64 KiB limit. SessionStart MCP hooks skip startup, resume and fork; after clear or compaction they run when the configured MCP owner is available, and their context is delivered once on the next prompt. Owner availability during clear remains dependent on extension lifecycle ordering. Reviewed plugin servers can use the built-in MCP owner; the separately owned automatic Octocode server remains outside this bridge. SessionEnd delivery also depends on the MCP owner still being available during shutdown. These limitations keep this a partial implementation of the [MCP hook contract](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields).

### Input rewrite preview

Source-profile PreToolUse `updatedInput` now replaces Bash and generic tool arguments after validating the registered schema. Codex requires `permissionDecision: "allow"` with a rewrite. The native pipeline rechecks reservations and permissions on the changed arguments; `allow` does not bypass Octocode permission policy. Conflicting rewrites, invalid arguments and user-typed shell rewrite requests refuse the call. Claude file rewrites reverse Write/Edit/MultiEdit projections into native queries, preserve native reasoning and validate the complete batch. The file executor enforces reservations and review on the rewritten destinations. The `replace_all` flag maps to native `edits[].replaceAll` with the matching limits described in the permission-request section. Codex patch rewrites use the canonical file mode described above; user-shell rewriting remains unsupported.

Claude Bash payloads translate native timeout seconds to milliseconds and `background` to `run_in_background`. Rewrites translate those fields back and retain advisory `description` metadata. A nonempty replacement drops omitted execution options; unknown source fields cannot set native-only options. Both PreToolUse and PermissionRequest use this adapter. Negative timeout values are currently rejected. Host timeout defaults, maximums and background-job lifetime remain native; argument translation does not establish complete execution-lifecycle parity.

## Claude failure and Stop feedback

`StopFailure` observes a final error outcome after the session’s automatic recovery has finished. It receives `error: "unknown"` and, when present, the provider’s error message in `error_details` and `last_assistant_message`. The adapter does not infer structured vendor error categories from message text. Successful and aborted outcomes do not emit this event. Its output and exit status cannot block or continue the run; terminal-sequence output is unsupported. Native and Codex configs do not accept `StopFailure`.

Claude Stop `hookSpecificOutput.additionalContext` continues the run as feedback, with the existing eight-continuation cap and reset on a new prompt or tool execution. An explicit `continue: false` from any Stop handler takes precedence.

## Claude batch completion

The source-profile `PostToolBatch` event fires once at the turn-end boundary after top-level tool calls resolve, including failed tool results. It ignores matchers. Each `tool_calls` item carries `tool_use_id`, `tool_name`, `tool_input`, and the model-visible `tool_response` content blocks. Native `file` remains one custom batched tool, with its native input, rather than being presented as multiple upstream tool calls.

`hookSpecificOutput.additionalContext` is persisted once before the next model request. Exit 2, `decision: "block"`, `continue: false`, or a configured blocking failure policy stops the run before another provider request and retains the reason in the conversation. Cancellation does not emit a completed batch. Common source metadata and exact host tool projection remain partial.

Codex preview output validation follows the pinned event-specific wire shapes for PermissionRequest, PreToolUse, PostToolUse, SessionStart, PreCompact, PostCompact, UserPromptSubmit, Stop, SubagentStart, SubagentStop and Interrupt. Unknown fields, wrong types and missing required decision reasons are diagnostic failures. Codex PreToolUse exit 2 requires a non-empty stderr reason; empty stderr does not deny the tool by itself. Non-empty successful PreToolUse stdout must be a JSON object. Failure handling still follows the configured failure policy.

For Codex Bash callbacks, `tool_input` contains only `command`. A rewrite changes that string and preserves native timeout/background options, matching the pinned Codex shell adapter. Remaining source-profile payload gaps include transcript format, unavailable vendor agent context and snapshot-aware native edit projection; these remain listed in the compatibility matrix.
