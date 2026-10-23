# Native Octocode features

octocode-code is a fork of [Pi](https://github.com/earendil-works/pi). The agentic features were developed as `packages/octocode-pi-extension` in the sibling `octocode` repository and migrated into this fork's [native runtime](../src/octocode/). The extension is a migration reference; the running agent does not import that package.

## Runtime ownership

The [resource loader](../src/core/resource-loader.ts) registers the native runtime automatically. `--no-extensions` controls external extension discovery; SDK embedders can set `nativeFeatures: false` on `DefaultResourceLoader` when supplying their own tool policy. Do not load the old extension alongside the native implementation: its tools and event handlers overlap. The Pi fallback loader excludes the old extension package from inherited package resources.

The composition in [octocode/index.ts](../src/octocode/index.ts) connects feature registration, session start and shutdown, permission checks and background work. It runs reservation checks, user hooks and permission checks in order. Domain modules supply their own behavior rather than each installing a competing global tool-call gate.

| Feature | Implementation | Use |
| --- | --- | --- |
| Guarded file changes and checkpoints | `files/` | `file`, `/rewind` |
| Shell execution and background jobs | `files/bash.ts`, `files/bash-jobs.ts` | `bash`, `/jobs` |
| Optional [DAP debugger](debugging.md) | `debug/` | Explicitly enable `debug`; provide an installed adapter |
| Code research | `mcp/` | Octocode MCP tools, `/mcp` |
| Subagents, external agents and role profiles | `subagents/`, `external/`, `instructions/roles/` | `agent` with type `task` or `external`, `/agents` |
| Team messages, reservations and coordination | `team/` | `agent` with type `message` or `coordinate` |
| Web retrieval and browser interaction | `web/`, `browser/` | `web`, `browser`, subject to active profile/tool selection |
| User questions and [permissions](permissions.md) | `ask/`, `permission/` | `askUser`, `/permissions` |
| [Command hooks](hooks.md) | `hooks/` | `/hooks` inspects; `OCTOCODE_HOOKS=1` enables at startup |
| Backlog and memory | `backlog/`, `memory/`, `agentdb/` | `/backlog`, `/memory` |
| Session recovery and compaction | `sessions/`, `compaction/` | `/resume`, archive tools and commands |
| Local session API and external agents | `api/`, `external/` | `/api`, `octocode-api` |
| Inbound [Agent Client Protocol](acp.md) | `../modes/acp/` | `octocode --mode acp` |

Run `/help` for the commands registered in the current mode. Child sessions intentionally have fewer capabilities, including no further subagent spawning or user-question UI.

`octocode --mode acp` lets an editor control Octocode, with one native worker per protocol session. It supports streamed text/tool activity, cancellation, single-use permission decisions and temporary client stdio, HTTP or legacy SSE MCP servers. It inherits host credentials, project trust and the configured permission mode, whose default is `full`. Saved sessions support load, resume and listing within their workspace. Client filesystem/terminal delegation and general terminal dialogs are not exposed. The `agent` tool's `type: "external"` / `transport: "acp"` path instead lets Octocode control another ACP agent; `/api` uses a separate local protocol. See the [ACP reference](acp.md) for the complete supported surface and limits.

## Find and run commands

In the terminal, `/help` (alias `/commands`) opens a searchable picker for core commands, native features, extensions, prompts, and skills. Add a search term, such as `/help model`. Selecting a command places it in the editor so you can add arguments before running it. `/skills` opens the same picker filtered to loaded skills.

| Command | Aliases | Purpose |
| --- | --- | --- |
| `/status` | `/info`, `/session` | Session statistics, native activity, loaded skills, then MCP connection status |
| `/resume` | `/sessions` | Browse and resume saved sessions |
| `/model` | — | Select the model for this session |
| `/models` | `/scoped-models` | Choose model cycling, catalog and agent routing, or local llama.cpp models when available |
| `/effort` | `/thinking`, `/reasoning` | Set reasoning effort |
| `/settings` | `/config` | Open session settings |
| `/rename` | `/name` | Set the session display name |
| `/keys` | `/hotkeys` | Show keyboard shortcuts |
| `/new` | `/clear` | Start a new session |
| `/bug` | `/feedback` | Report a bug |
| `/quit` | `/exit` | Leave the session |

`/trust` separates project resource trust from native project configuration trust; its menu also offers revoking native configuration trust. `/agents` manages local agents, and `/agents external` reaches connected external agents. Other native features use direct commands such as `/permissions`, `/hooks`, `/memory`, `/backlog`, `/rewind`, `/jobs`, `/archive`, and `/api`.

The old `/octocode ...` prefix only displays migration guidance. It does not execute the requested action or send it to the model. Run the suggested direct command to continue. Terminal pickers are interactive UI; SDK and RPC command discovery expose registered extension, prompt, and skill commands without adding the terminal's core commands.


## Backlog view

`/web` opens the live workspace on Activity, where you can follow agent output and send commands. `/web backlogs` opens its task board. Both commands share one local server with `/backlog`; switching views stays in the same SPA. Keep the terminal session open while using the web workspace.

In interactive sessions, `/backlog` opens the repository task board in your default browser. All tasks appear in Backlog, Todo, Ongoing and Done columns. Search across task fields, notes and completion records, filter by priority, type or readiness, or switch to Table, Tree and Attention views. Select a task to inspect its details and history; Escape closes the details.

The local board supports creation, editing, status changes, epic children, dependencies, and completion summaries with related files and verification. It receives live updates over an authenticated local WebSocket while the session stays open and reconnects automatically; it does not overwrite an open edit form. Changes from other agent processes are detected within roughly half a second. Stale saves are refused so another session's changes are preserved. The server binds only to loopback and uses a per-launch access token; its address is local to this session. `/backlog web` opens it explicitly.

The web view also includes **Agents**, **Activity**, and **Audit**. Item details have a dedicated **Add comment** action with stable comment IDs. Every new change is recorded transactionally with its actor and before/after values; the audit includes deleted items and supports loading older events. Existing notes become comment records when the database is upgraded; earlier field edits are not reconstructed.

Use **Send to agent** to contact a live agent explicitly. **Work with current agent** queues the item's context in the current session; **Request new agent** asks that agent to delegate through the existing launch and permission flow. Accepted requests are shown separately from agent progress and completion. Repeating the same request ID does not resend it. Agent permission dialogs remain in the terminal. The Activity view renders the same structured agent report as the terminal, with a bounded recent feed; the transcript retains complete output.

`/backlog html` writes a read-only offline snapshot at `.octocode/backlog.html`; without a UI it writes the file without opening a browser. No-argument `/backlog` in headless mode still prints the board. The general session API keeps its existing browser restrictions.

Capture needs only a title. Starting needs a reason and goal; finishing needs a summary, files (empty is valid), and an explicit verification result. `type: epic` groups children via `parentId`; `dependsOn` identifies prerequisites. Reopening retains completion history and requires a reason. An item with children, dependents, or completion history cannot be silently deleted. See the [entity model](../../../docs/ENTITIES.md).

Database upgrade adds backlog fields and history tables. Once upgraded, older builds can read existing data but their backlog writes fail because they lack the `octocode_backlog_writer` and `octocode_audit_actor` capabilities. Upgrade other processes sharing that database before editing backlogs; reverting the executable does not remove this guard.

Use `/backlog tui` for the interactive terminal board, `/backlog add <title>` to create a task, and `/backlog <id> <state>` to change its state. `/backlog do <id>` hands a task to the agent. `/backlog export` writes the Markdown snapshot.

## Tool selection and migration

Native sessions enable `file`, `bash`, `agent`, `web`, `askUser`, `backlog`, `memory` and `archive` by default. The registered `browser` tool is selected by the browser specialist. The registered `debug` tool is opt-in through tool selection; it uses process permissions for all operations except termination and is refused in read-only and isolated child roles. Native tools are not automatically MCP servers; ACP client MCP configuration exposes server tools to the session, not the native debugger to remote callers. Octocode MCP supplies local and remote research tools. The standalone `read`, `ls`, `find`, `grep`, `edit`, `write`, `powershell`, `externalAgent`, `coordinate` and `sendMessage` names are not registered in native sessions. Update explicit tool lists and hook matchers to the names below. SDK sessions using a `DefaultResourceLoader` with `nativeFeatures: false` have `bash` as their only built-in tool, and it is the default selection (`defaultTools`, `--tools`); add other tools with `customTools` or an extension. Sessions and exports that already hold calls of the removed names still show them, through the generic tool renderer. The SDK no longer exports `createReadTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`, `createPowerShellTool`, `createCodingTools`, `createReadOnlyTools`, the matching `create…ToolDefinition` factories, their `…Operations`, `…ToolOptions`, `…ToolInput` and `…ToolDetails` types, `createLocalPowerShellOperations`, `formatReadLineRange`, or the typed `Read`/`Edit`/`Write`/`Grep`/`Find`/`Ls`/`PowerShell` tool call and result events with their `is…ToolResult` guards; `isToolCallEventType` narrows only `"bash"`, and other names take explicit type parameters. `ToolsOptions` accepts only `bash`.

Use Octocode `localFetch` for known source files and skill instructions, `localSearch` for text matches, and `structureSearch` for paths. The file guard credits successful untransformed numbered source reads, including separate line windows, only when the file stays unchanged throughout retrieval. Filtered, minified, byte-window, failed or truncated results do not establish complete coverage. Fetch the original line ranges before replacing a whole file. When the Octocode MCP server is off, disabled or failed to start, the model reads with `bash` and the guard's refusals name `bash` as the reader. A `bash` call counts as a read of a file only when it is one literal command that prints that file: `cat FILE...` (whole file), `head [-n N] FILE`, `tail -n +N FILE` or `sed -n 'A,Bp' FILE` (the lines printed). A pipe, redirect, command list, substitution, glob, variable, background job, failed call or call made by another tool counts for nothing, and a result the tool cut counts only as a partial read: an edit may follow, a full write needs the remaining lines (`sed -n 'A,Bp' FILE`). The guard remembers these reads for the live session only; after a resume or compaction read the file again.

A complete credited local source read also appends its whole-source SHA-256. An edit may use `edits: [{ line, sourceSha256, oldText, newText }]` for an exact complete-line anchor; stale or partial source identity is refused, and the normal writer, read guard and checkpoints still apply. A committed mutation returns a receipt even if later cleanup fails. Native sessions collect bounded parser observations and LSP diagnostics through the callable Octocode tools; set `OCTOCODE_EDIT_DIAGNOSTICS=0` to disable these observations. Unavailable, unpublished or timed-out feedback is not a clean result. Parser and LSP source versions remain unverified, so a newly observed parse error is a possible regression, not proof.

Older Octocode servers expose `localGetFileContent`; unminified results (`minify: "none"`) also establish read coverage. Local source retrieval does not replace the former reader's image decoding; use image attachments or an image-capable MCP tool for that.

Shell commands use `bash({ type: "bash", command: "..." })` or `bash({ type: "powershell", command: "..." })`. The type defaults to Bash; PowerShell retains its Windows requirement. Both modes support foreground deadlines and background jobs. A foreground command still running at its deadline (default 15 minutes, at most an hour) is not killed: it moves to the background as a job, its output so far and later goes to the job log, and its exit is reported like any background job (stop it with `/jobs kill <id>`; a headless run stops it when the run ends). A command starting with `sleep` and a call the user aborts are still stopped. The configured Bash command prefix applies only to Bash.

Use `bash({ command: "yarn test", verify: true })` when the command is a verification step. Its receipt records command, exit or signal, output availability, and mutation revisions at launch and completion. A background handoff remains running until its completion report. Later file-tool commits make the evidence stale. Revisions belong to one process epoch and session; they do not track shell writes, external editors or other processes. A zero exit code describes only the command actually run.

Agent operations share an envelope: `agent({ type, input })`.

| Type | Input and behavior |
| --- | --- |
| `task` | `goal`, `task`, optional `skills` (loaded skill command names), profile/model/headless/background/isolation options; launch a native child |
| `external` | `action: list/connect/prompt/cancel/disconnect` and connection fields; reach ACP or other Octocode hosts |
| `coordinate` | `action: list/join/leave/lock/unlock/stop/changes` and action fields; manage team membership and reservations |
| `message` | `message`, optional `to`, `replyRequired`, `replyTo`, `interrupt`; communicate with teammates |

Children inherit the parent's accepted skill inventory by default, including model-only resources and eligible explicit path-selection candidates hidden by a name collision. Pass an optional subset of skill command names in the task's `skills` array, or `[]` for none, and explain required workflows in `task`. Explicit selection still requires an available skill command: a model-only name is not a selectable command, and a skill with `disable-model-invocation` is refused because the child's model would never see it. Unknown or ambiguous names fail before launch; use qualified command names when skills collide.

The child receives captured resource identities and invocation policy, including plugin-qualified names, argument variables and prompt limits. Its skill loader adopts this inventory instead of rediscovering skills from its environment. Resumed children retain the captured inventory. This snapshots metadata and paths, not file contents: instructions are read from the captured canonical file when needed. Retargeting a discovery symlink cannot substitute a different skill: the child refuses the inventory. A skill whose file was deleted or moved since capture is left out with a warning, and the other skills still load. References use the same resource roots; tool permissions remain unchanged. See [skill inheritance](skills.md#child-skill-inheritance).

Child sessions expose only the coordination and message modes, with their existing action restrictions. Every specialist keeps `file`, `agent`, `archive` and the available Octocode local research tools, including source fetch, text/path search, structure, AST and LSP tools. Restrictive allowlists gain these tools. Profiles that remove them or set `mcp: false` are rejected with a migration diagnostic; a global MCP opt-out still applies, so disabled or disconnected servers cannot supply local tools. Researcher and reviewer roles use `file` for requested reports and scratch artifacts while leaving source files unchanged. Hooks see the public `agent` name and its nested input. Permissions, provenance checks and domain lifecycle handling still apply to each operation.

MCP tools use automatic exposure: small catalogs are called directly; large catalogs use discovery on transports that support native tool loading. MCP resource tools access server-owned URIs, and `tool_search` discovers tools rather than source files. The [`mcp` tool](mcp.md#let-the-model-manage-servers) lets the model, and each subagent for its own session, list, restart, stop or add MCP servers; restrictive allowlists gain it with `tool_search`. Skills are instructions loaded from files, not duplicate executable tools.

## Browser and web access

The main agent keeps `web` enabled for public search and retrieval: `web({ query: "search terms" })` or `web({ url: "https://example.com" })`. Browser interaction is delegated to the single `browser` specialist, so the main agent does not carry the browser tool schema by default. Chrome starts on first use inside the specialist.

```json
{
  "type": "task",
  "input": {
    "profile": "browser",
    "headless": false,
    "goal": "Check the signed-in dashboard",
    "task": "Open https://example.com/dashboard and report what is visible."
  }
}
```

Pass this envelope to `agent`. `headless` defaults to `true`; `false` selects visible Chrome with its persistent login profile. Both modes use the same role instructions and browser actions, plus `web`, `file`, local research and communication. User authorization and browser permission checks still apply. The browser mode belongs in the child task and launch environment; its cached role text stays identical across modes. Stable instructions permit provider cache reuse but do not guarantee a cache hit.

Replace calls to the former `webHeadless` and `webLive` profiles with `profile: "browser"` and `headless: true` or `false`. Custom profile YAML can set a `headless` default; legacy `visibleBrowser` is accepted as its inverse when `headless` is absent.

Explicit tool selections still apply: `defaultTools: ["+browser"]` or `--tools +browser` enables direct browser access when desired, and `-web` omits retrieval. Existing resumed sessions retain their recorded tool selection; start a new session or explicitly remove `browser` to offload it from an older session.

## File mutation guarantees

Native `file` edits, writes and deletes check the current content under a shared filesystem lock. Core `edit` and `write` also use atomic replacement; core edits verify the bytes they read before committing. These locks serialize cooperating Octocode processes and resolve symlink aliases. Core `write` remains an intentional full overwrite and does not require a prior read.

Atomic replacement prevents torn files. It does not exclude unrelated editors, shell commands or other processes that ignore the lock. Team reservations are enforced for `file`, core `edit`/`write` and the `bash` write targets the shell parser can name (redirects, `tee`, `rm`, `mv`, `cp`, `sed -i`); a command whose targets it cannot name (`> $FILE`, a script, `git checkout .`) and PowerShell are not checked, so inspect files after concurrent shell work. A reservation lapses 90 seconds after its owner's last heartbeat and is not fenced: an owner that stalled longer and then resumes can write over a peer that took the file. File batches report each outcome and do not roll back earlier successful changes.

### Canonical patch mode

The existing `file` tool accepts either native `queries` or a Codex `patch` string, never both. Patch calls can include a `reasoning` string. Add, Delete and Update operations, Move destinations, context chunks and EOF markers are handled by the same file owner; this does not register a second file tool.

Patch mode prepares every operation before the first mutation. Invalid later operations, duplicate source paths and failed file guards prevent the whole preparation from committing. During execution, cancellation or the first failure stops later operations; earlier committed changes remain recorded for `/rewind`. A move writes its destination before removing its source, with guards and checkpoints for both paths. Native query batches keep their existing continue-after-failure behavior.

Update matching and line-ending behavior follow the pinned Codex transformer. Existing read coverage, stale-content checks, workspace permissions and reservations still apply. A patch update does not turn a partial read into whole-file coverage. Local path forms that Octocode would normalize differently and remote environment routing remain unsupported. See [hook patch compatibility](hooks.md#codex-file-patch-preview) for protocol projection and rewrite limits.

## Live status

The main agent has a live activity display above the input. Its first row shows `Main`, run elapsed time, run tokens and the session compaction count; the second row shows the current action and elapsed time for a step lasting at least two seconds. Wide terminals also show the interrupt shortcut. Long action descriptions are clipped to keep the input steady. Shell commands also appear in the message list with their running state, elapsed time and output.

The live timer includes tool waits and automatic compaction. Run tokens include completed messages and streaming usage when the provider reports it; the display does not estimate tokens from text. When the run settles, the footer keeps its duration as `last run` until the next run starts. Session totals count new prompt tokens (uncached input and cache writes) plus output, including reported subagent usage; cache reads are listed beside them (`↑72k +1.1M cached ↓35k`), because every request re-reads the conversation, so they grow with each turn while costing a fraction of new tokens. The agents panel and `coordinate list` use the same format for each agent's spend since it joined. Totals appear alongside the count of completed compactions. These totals include resumed session history; token counts update when messages finish. Narrow terminals shorten or hide lower-priority details.

## Communication and results

Team messages remain queued until they reach the recipient's model context. Ordinary delivery waits for acknowledgement of the previous batch and targets 32 KiB of serialized messages per batch. Messages are never split: one oversized message travels alone, and excess mail stays in SQLite. Interrupts and requests that wake an idle recipient can pass the ordinary backlog. A reply completes the original question only when it is sent to the asker; sending the same reply to someone else does not mark the question answered.

Background subagent reports keep recovery copies under their originating session until the session transcript records them. Asynchronous delivery rejection triggers three quick retries after 1, 2 and 4 seconds, then three slow ones after 30 seconds, 1 minute and 2 minutes, keeping the same report ID; the report is saved for the next start when they are exhausted. While the parent is in the middle of a turn, a report that wants action also leaves a short hidden notice (agent, outcome, and the saved report's path when there is one; never the child's words) that the parent model reads at its next step; the full report still arrives as a follow-up when the turn ends. Receipts are found by reading only the lines the session transcript gained since the last check. Accepted queued reports wait for their receipt without being resent. Restarting that session reconciles report IDs before replaying pending reports. A session switch during a pending-report scan returns those reports to the original session.

The latest completed report determines the displayed outcome, independently of the accumulated report history. A failed follow-up is reported as a failure while preserving earlier results as partial evidence.

The native `agent` task accepts an optional `resultSchema` for callers that need a machine-readable result. Pass a bounded JSON Schema object using `type`, `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `const`, `description`, or numeric and length bounds. Remote references, patterns, custom keywords and executable schema definitions are rejected before the subagent is claimed or spawn permission is requested. The child receives an immutable copy and is asked to end its ordinary report with `Structured result:` followed by one fenced `json` block. The host validates that complete final answer before shortening the human-readable preview; `details.structured` carries version 1, its SHA-256 schema hash, `valid`/`invalid`/`unavailable` status, and data only when valid. A schema-enabled foreground task is successful only when the run reports `done` and the structured status is `valid`; background launch still returns immediately, and its later durable report carries the verdict. Cancellation and failed final replies leave the structured result unavailable. Runs without `resultSchema` retain their existing text and outcome behavior. The accepted contract is saved in the child's private session folder for recovery; replay rejects corrupt or unknown verdict versions without reinterpreting them under a newer schema.

A report's outcome is its first word (`done`, `partial`, `blocked`, `failed`), optionally after one `Report:`, `Status:` or `Outcome:` label (`**Report: partial.**`, `Status: done`). Any other opening leaves the outcome unknown, which is not a failure. So does a first word that is plain prose (`Done with the audit, but blocked by X`) when its line names another outcome word.

A subagent that exits before its first model turn reports `failed (startup)`: the exit reason, the first error line of its stderr and the path of the saved `stderr.txt`, not the stderr tail. When that stderr shows a module-load error (`ERR_*`, `SyntaxError`, `Cannot find module`), for example because a source file was being edited as the child started, the child is started once more after 1.5 seconds; no tool ran, so nothing repeats. A stop is never retried. A child that got as far as a model turn or a tool call fails with its stderr tail as before.

A background subagent that reports `blocked` stays resumable for at least 10 minutes, even with `OCTOCODE_SUBAGENT_LINGER_SECONDS` at its default of 0: the report footer says so, and `agent` with type `message` to its id continues the saved conversation. A positive setting that is longer than 10 minutes applies instead. When the window ends the saved context is released, and a later message gets the usual "has finished" answer. Runs in an isolated worktree are not resumable.

`/agents stats` summarizes this session's subagent runs per role (`general` when none), computed from the session transcript so it survives reload: foreground `agent` results and background `octocode-agent-result` reports, the latter counted once per report ID. For each role it shows runs, outcome counts (done, partial, blocked, failed, unknown), the share of normally ended runs that led with an outcome word, total and average tokens (input, output, cache reads and writes), cost (`n/a` for usage from a model without pricing), asks, startup failures and compactions. Startup failures count runs whose details carry a `startup.failed` marker; where a run has no `startup` field, every failed run counts. The average cold start (the first model turn's context size) appears only for runs whose details carry `firstTurnTokens`. Aggregation lives in [stats.ts](../src/octocode/subagents/stats.ts).

## Compaction and recovery

Compaction uses the built-in policy. Settings and external extensions cannot replace its summary, budget or cut point; `/compact` requests the same flow manually.

The model learns how full its context is from usage notices: when a turn ends with the context past half, three quarters or nine tenths of the room before automatic compaction (the window less the reserve), Octocode adds one hidden message such as `[Context] 140k of 184k usable tokens used (76%); about 44k left before automatic compaction summarizes older turns. The window is 200k.` Each band is noticed once per compaction cycle, also across a resume; the system prompt never changes for it, so the prompt cache is kept. See [context-notice.ts](../src/octocode/compaction/context-notice.ts).

The final checkpoint is checked together with retained messages, the current system prompt and tool declarations. Oversized complete checkpoints and long user-message collections are saved beside the session JSONL and represented by recovery references. Long tool results passed to the native standalone summarizer are likewise saved whole. Search these files and read relevant ranges when recovering details. Keep the checkpoint files with the session when moving or backing it up.

An in-memory session (`--no-session`) has no session file to save beside, so nothing is saved: a long tool result, a long user message or an oversized checkpoint stays inline, cut to its budget with a marker that says how many characters were omitted (the head and tail stay), and compaction completes. Only a session file that cannot be written fails compaction.

The original transcript remains available when the session has a file. If complete content cannot be saved to it, or the retained context and recovery reference cannot fit, compaction fails without advancing its boundary. A failure counts toward the three consecutive failures after which automatic compaction stops until `/compact` or a new session; a cancel by the user does not. A summary the model already wrote is kept for the next attempt over the same messages, so a failure after that call is not paid for twice. Context sizes use one token estimate for core and the add-ons, three characters per token (code, paths and JSON run nearer three than prose's four, so it errs on the safe side); the system message's declared tools are part of it, and tools the transcript does not declare yet are added before a request. Provider-side limits can still reject a request. Summaries condense information for the working context, while the original content remains recoverable.

If appending a transcript entry fails, the live session restores its previous branch and blocks further writes. Inspect and recover or reload the transcript before continuing. An incomplete final record is preserved and cannot be appended to. If the bytes were written before the disk flush failed, the disk may already contain that entry; this uncertain outcome is not silently retried.

## Configuration

The native runtime uses the [shared configuration locations](configuration.md) and [environment variables](environment-variables.md). Provider configuration, built-in MCP and third-party extensions retain their existing core loaders. `/status` lists loaded skills followed by all MCP connection states. `/mcp` manages configured MCP servers and `/mcp reconnect octocode` reconnects the Octocode research integration. See [MCP configuration](mcp.md) for global/Pi fallback, enablement, exposure and cache behavior.

Bundled role profiles are defaults. User and trusted project profiles can override them by name; a project file that replaces an earlier profile is named in a warning at session start. Their model, tools and permission declarations are read by [profiles.ts](../src/octocode/subagents/profiles.ts). A profile with `readOnly: true` (the bundled `reviewer`, `researcher` and `browser`) still has `file` for its own reports and scratch evidence, but its child gets the investigate-and-report policy instead of the rules for changing code, and the permission gate refuses its other changes in every mode (see [read-only roles](permissions.md#read-only-roles) for what it may still write). See [agent instructions](instructions.md) for the distinction between stable system policy, role text and child task context.

A subagent cannot ask anyone, so it runs with what its parent decided at spawn. In `full` mode the child inherits the mode. In `manual` or `workspace`, the spawn dialog names what the profile's tools reach (`edit files in the repository`, `run shell commands`) and the permissions its profile declares; approving it, once or for the session, grants those classes for the child's whole run, without a dialog per call. That is deliberately looser than the parent's mode alone, and the dialog is the consent. A class that always asks (destructive shell, a change outside the workspace, browser control unless the profile declares it) never passes down this way, and a mode change that makes an action ask stops running children and clears the grants.

Finished workers can remain addressable for the configured `OCTOCODE_SUBAGENT_LINGER_SECONDS` window (default off; a blocked report gets at least 600 seconds). A message explicitly revives the parked conversation with fresh authorization and capacity checks. Restart recovery requires the same parent session, workspace, profile and surviving transcript; expiry or explicit stop removes the address. Pending mail does not automatically relaunch work.

`workingCopy: true` with `isolate: true` starts the child from a snapshot of tracked and non-ignored untracked working files. It preserves the parent index and branch. Export removes baseline-only changes; if the worker delta cannot apply cleanly to the original HEAD, the worktree is retained for review instead of exporting an ambiguous result. The default still starts at HEAD. `/agents merge` still requires a clean parent tree.

`isolate: true` also contains the child's writes: in every mode, including `full`, a `file` change or a parsed shell write into the parent's main tree is refused ([`permission/isolated-tree.ts`](../src/octocode/permission/isolated-tree.ts)); the child writes its own worktree and its scratch folder, and the user lands the result with `/agents merge`. Like the read-only guard it is not a sandbox: a program that writes by itself (`node script.js`) is not seen.

## Migration differences

- Extension `src/index.ts` became native `src/octocode/index.ts`, registered by the resource loader.
- Extension `src/prompt.ts` became `instructions/policy.ts` and `instructions/task.ts`. Report outcomes have one owner in `instructions/report.ts`.
- Extension `subagents/*.md` became packaged assets in `instructions/roles/`. Role handoff preserves the user's independent `APPEND_SYSTEM.md`.
- Extension `external/pi.ts` became `external/octocode.ts`, targeting this fork's process entry points.
- The old extension's stale-bundle helper is absent: native source/bundle selection belongs to this repository's build and launch machinery.
- Imports use the fork's runtime packages and local core modules. Source-tree similarity alone is not proof of feature parity; lifecycle and integration tests validate the host boundary.

## Validation and limitations

`test/octocode/` contains the migrated feature tests. `vitest.octocode.config.ts` runs them separately from the core coding-agent suite and excludes live e2e and Chrome tests. Native resource loading, SDK configuration and compatibility also have tests in `test/`. See [development guidance](../../../AGENTS.md) for commands.

The native runtime supports one active SDK session per process. Permissions are application policy, not an operating-system sandbox. Live provider authentication, browser interaction and external-agent integrations need their own configured integration checks; an offline unit-test pass does not establish those behaviors.
