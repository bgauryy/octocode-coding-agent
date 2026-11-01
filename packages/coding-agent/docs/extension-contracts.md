# Extension contracts

Part of the [extensions guide](extensions.md). Use the exported declarations in [`extensions/types.ts`](https://github.com/bgauryy/octocodecode/blob/main/packages/coding-agent/src/core/extensions/types.ts) for exact types.

<a id="events"></a>
<a id="work-with-events"></a>

## Events and concurrency

Handlers run in extension load and registration order. `octocode.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress.
Some events notify; others transform data, replace results, or cancel an operation.
Use each event’s declared result type rather than assuming every return value has an effect.

Events cover resource discovery, sessions, agent and message lifecycle, providers, tools, and raw input.

### Understand handler composition

| Pattern                | Behavior                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification           | Return values are ignored. Use the event for observation only.                                                                                                        |
| In-place mutation      | Later handlers see changes to values such as `before_provider_headers.headers`, `before_agent_start.systemPromptOptions`, and `tool_call.input`.                      |
| Chained transformation | Later handlers receive the value returned by earlier `input`, `context`, `context_with_system`, `message_end`, `tool_result`, and `before_provider_request` handlers. |
| Gate                   | A handled input, blocked tool call, cancelled session operation, or handled `user_bash` command stops that operation's normal fallback path.                          |
| Actionable boundary    | Each `turn_end` or `agent_before_settle` handler sees the entries and continuation decision proposed so far.                                                          |
| Last override          | The last `cache_warming_decision` handler that returns an action wins.                                                                                                |

Notification handlers should not perform slow work on a streaming event. Transform handlers should preserve fields they do not intentionally own, and gate handlers should fail closed when their safety decision cannot be made.

`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. `event.messageType` says what started the run: `"user"` for a prompt or `octocode.sendUserMessage()`, with `prompt` and `images`; `"custom"` for `octocode.sendMessage(..., { triggerTurn: true })`, with the starting `message` and no `prompt`. A returned `message` is added to either kind of run; check `messageType` to skip runs started by custom messages. Prefer changing prompt sections, selected tools, or guidelines so Octocode can append a transcript delta. Setting `systemPromptOptions.sections.<name>` to an empty string removes that section, including a default one such as `docs`. A known section name takes its declared place (`src/core/system-prompt-spec.ts`); other `sections` end the session sections, before `environment`, and other `baseSections` follow `mcps`. `turn_prompt` runs before each later request of the same run with that turn's `systemPromptOptions`, for sections whose content changes mid-run (Octocode's MCP producer uses it); a change is sent as a section patch. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt.

`user_input` runs when a user item is consumed, before message persistence and Codex mention-skill reads. It receives the processed user text, images, source and queue behavior. Return `{ block: true }` to omit that item or `{ additionalContext: [text] }` to record hidden context after accepted input; blocked input can still retain context. Blocking decisions accumulate and context preserves handler order. Initial input runs after `agent_start` and `turn_start`; queued input runs after continuation preparation and its `turn_start`. Each finalized item is recorded before the next item is checked, so cancelling a later hook retains earlier accepted history. Custom context messages do not invoke this event. `AgentSession` owns the lower-level `Agent.prepareInput` callback and rejects an agent that already supplies one; session integrations should use `user_input`. Standalone `Agent` users can use the lower-level callback directly. Existing admission-time `input` transformations and slash/template expansion retain their behavior.

`ctx.getTurnId()` returns the active logical turn identity. Tool iterations, steering, retries and Stop continuations share it. A selected follow-up batch gets a new identity before continuation preparation; merely queueing a message does not change it. The identity remains available during `agent_settled` and is cleared afterward. Outside a run it is undefined, including idle manual compaction.

`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution, and can return `revalidate`, an async check that runs right before the tool executes (a parallel batch approves every call before running any, so an approval can go stale); it returns `{ block: true, reason }` to refuse the call, and a throw refuses it too. Every handler's check is kept and run in load order, even when a later handler returns its own result. Octocode's own gate returns one for `bash` and `powershell` calls so a peer's path reservation made after approval still blocks them. `tool_result` handlers compose, with each handler seeing prior changes.

<a id="provider_stream_event"></a>

`provider_stream_event` fires for each parsed provider stream event before Octocode normalizes it. The event identifies the provider, API, and model; `event.data` is the earliest structured value available to Octocode, not necessarily the original HTTP bytes or SSE frame. Treat it as read-only because mutation can affect normalization. The event is notification-only and is not persisted.

Handlers are awaited in stream order, so slow handlers delay stream consumption. Handler errors are reported without changing the provider response. See `debug-provider.ts` for an opt-in viewer that groups raw events by assistant message.

<a id="context_with_system"></a>

`context` transforms conversation messages without prompt and tool system messages; Octocode restores that state afterward. Use `context_with_system` only when a request-local transformation must own the complete transcript, and keep a system message at index zero.

`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed `custom`, `custom_message`, or `context_edit` entries and return `continue: true` for one next model request. Guard continuation conditions because an unconditional continuation can loop. Use the exported event declarations for the complete validation and ordering contract.

<a id="cache_warming_decision"></a>

`cache_warming_decision` can override an idle prompt-cache refresh with `{ action: "warm" }` or `{ action: "stop" }`. The last handler that returns an action wins.

Tool calls from one assistant message can run in parallel.
Do not assume a sibling call or result exists when another tool event runs.
Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal.

A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution.

<a id="custom-tools"></a>
<a id="register-tools"></a>

## Tools

A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function.
Its result requires model-facing `content` and a `details` field for rendering or state reconstruction.
Use `details: undefined` when there are no structured details. If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate.

Throw from `execute()` to produce a failed tool result.
Returning an object does not mark it as an error.
Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate.

Use sequential execution when tools share mutable in-memory state.
File-mutating tools should wrap the complete read-modify-write operation with `withFileMutationQueue()`.
Truncate large model-facing results and tell the model where to read the complete output.

Declare `outputSchema` and return matching `structuredContent` when the result is data. The model receives `content`; programmatic consumers can read `structuredContent` from the tool result. Return `isError: true` for failures that still carry data. Keep both content forms consistent when redacting a result.

A tool can run other tools with `ctx.executeTool(name, args, { signal, onUpdate })`. Nested calls go through argument validation and the `tool_call` and `tool_result` handlers like model-issued calls, and emit `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`; all of these events carry `parentToolCallId`, and their `toolCallId` is assigned by octocode as `<parent id>/<n>`. These ids do not appear as tool calls or tool results in the transcript. Nested calls do not add transcript entries: their results only reach the calling tool, which reports them itself, for example through `onUpdate` and `details`. The session keeps a bounded record of them (name, arguments, status, duration, error; never results) as `nestedCalls` on the calling tool's result message. It is used for compaction file lists and shown in HTML exports. Arguments over 8 KiB per call or 32 KiB per tool result are omitted, at most 256 calls are kept, and `complete: false` marks a record that lost anything. The `usage` of nested results, at every depth, is added to the calling tool's result `usage`, so a tool reports only its own usage, not that of the tools it called. `ctx.tools` lists the tools `ctx.executeTool()` can call. `tool_result` handlers that redact `content` should also replace `structuredContent`; replacing only `content` drops it.

See `hello.ts`, `todo.ts`, `dynamic-tools.ts`, and `truncated-tool.ts`.

## Tool exposure

`exposure` controls how the model reaches a tool. "Callable" means callable from other tools through `ctx.executeTool()`:

- `direct` (default): declared to the model while active, and callable while active.
- `model-only`: declared to the model while active, never callable. Use it for tools that orchestrate other tools or ask the user.
- `hidden`: registered but unreachable. Re-register a tool with `exposure: "hidden"` to withdraw it, since tools cannot be unregistered.

`namespace: { name, description, instructions }` groups related tools, as MCP servers do. Instructions provide server-specific usage guidance.

Registering a `direct` or `model-only` tool activates it unless it sets `defaultActive: false`, which leaves it to selections that name it (`--tools`, `defaultTools`) or `octocode.setActiveTools()`; a `hidden` tool is never activated. The active set (`octocode.getActiveTools()`, `octocode.setActiveTools()`) is the set of tools declared to the model. `octocode.getAllTools()` reports each tool's `exposure`, `namespace`, and `annotations`. `octocode.selectsTools(prefix, activeByDefault)` says whether the session's tool selection could declare tools whose names start with `prefix`, so an extension can skip starting a source of tools nobody selects, as the MCP host does per server.

`annotations` are hints about what a tool does, with the meaning of MCP tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Custom extensions may attach these hints to their own tools. MCP server annotations are discarded, and the native permission gate does not consult hints. An extension can implement its own policy; for example:

```typescript
octocode.on("tool_call", async (event, ctx) => {
	const hints = octocode.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
	const needsApproval =
		hints?.destructiveHint === true ||
		(!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
	if (needsApproval && !(await ctx.ui.confirm("Allow tool call?", event.toolName))) {
		return { block: true, reason: `${event.toolName} was not approved` };
	}
});
```

A tool that orchestrates other tools can adjust what the model sees while it is active with `prepareLoadout(loadout)`. It runs whenever the active tools change and receives the declared tools, the callable tools, and every registered tool with its exposure, namespace, and prompt guidelines. It returns replacement `descriptions` for declared tools (including its own) and `hiddenDeclarations`: active tools whose declarations requests leave out while they stay active and callable. The default system prompt lists a declared tool in its `<tools>` section as `- name: trigger` when the tool sets `promptSnippet` (one short line on what the tool is for, plus when to use it where that decides the choice between tools; listed with or without a custom `SYSTEM.md`; every native tool sets one, MCP tools are described in `<mcps>` instead, and the section is left out when no tool has one), leaves hidden tools out of that list and the rules, and names no tool in the skills hint when the file reader is hidden, so the orchestrating tool should present their guidelines itself.

## Activate tools dynamically

Register every tool first, keep optional tools inactive, and use `octocode.setActiveTools()` from a loader tool to select the desired active tools. Names must already be registered; unknown names are ignored.

Octocode records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix.

## Tool rendering

A tool's `renderCall` and `renderResult` draw its calls in the interactive transcript and in HTML exports. `octocode.registerToolRenderer((toolName, next) => renderers)` chooses renderers for calls to any tool, including tools that are not registered yet, such as MCP tools in a resumed session before their server connected. `next()` returns what the remaining resolvers (in extension load order), then the registered tool, would use, so `next() ?? mine` only fills in.

In the interactive transcript, a renderer that throws does not stop the terminal. The row shows the plain call or output and a warning that names the error, such as `renderResult failed: TypeError: …`, so check that line when a custom renderer falls back.

## MCP servers

`octocode.registerMcpServer(name, config)` adds an MCP server for the current session. `config` has the shape of an `mcpServers` entry in [`mcp.json`](mcp.md): `command`, `args`, `env`, `inheritEnv`, and `cwd` for stdio servers, `url`, `headers`, and `oauth` for HTTP servers, plus `exposure`, `toolExposure`, `defaultActive`, `description`, `enabled`, and `timeout`.

```typescript
octocode.registerMcpServer("jira", { url: "https://mcp.example.com/jira" });
octocode.unregisterMcpServer("jira");
```

Registered servers declare their tools directly, and the server's instructions appear once in its prompt section. Set `defaultActive: false` to give the server only to the agents whose tool selection names it; see [assign servers to agents](mcp.md#assign-servers-to-agents).

Servers registered while the extension loads connect when the session starts, together with the `mcp.json` servers; servers registered later connect right away, and `octocode.unregisterMcpServer()` closes the connection and makes the server's tools unreachable. Registrations are not saved: register again on every load, for example based on the extension's own settings. A server in `mcp.json` with the same name takes precedence, and `/mcp` shows the override. Registering the same name again replaces the extension's earlier registration; names registered by another extension, invalid names, and invalid configs throw.

The built-in MCP support connects registered servers. When nothing does, because another extension replaced it (see [MCP](mcp.md#replace-the-built-in-mcp-support)), each registration is reported as an extension error. Other MCP extensions can connect registered servers too: read them with `octocode.getMcpServers()` on `session_start` and handle the `mcp_servers_change` event for later changes.

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>
<a id="use-extension-context"></a>

## Context and session changes

`ExtensionContext` provides the working directory, mode, UI, session manager, model runtime, abort signal, context usage, and controls for compaction and shutdown. `ctx.hasPendingMessages()` says whether queued messages wait; `ctx.isMessageQueued(details)` says whether a custom message sent with that exact `details` object (compared by identity, not equality) still waits in the agent's steering or follow-up queue.
Use `ctx.modelRegistry.streamSimple()` for provider-neutral nested model calls.

Command handlers receive `ExtensionCommandContext`, which adds operations for waiting until idle, reloading, tree navigation, and session replacement.
These operations are command-only because calling them from lifecycle handlers can deadlock the runtime.

Session replacement invalidates the old context. Capture only plain data before switching, then use the fresh context supplied to `withSession` for session-bound work.

<a id="state-management"></a>
<a id="persist-state"></a>

## State

Choose storage based on how state participates in the conversation:

| State                                       | Storage                  |
| ------------------------------------------- | ------------------------ |
| Tool state that follows the active branch   | Tool-result `details`    |
| Durable data excluded from model context    | `octocode.appendEntry()` |
| Custom content stored and sent to the model | `octocode.sendMessage()` |
| Data outside one session                    | External storage         |

Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`.
Do not rebuild it from every file entry because abandoned branches represent alternative histories.
Register an entry or message renderer when custom stored content should appear in the transcript.

`octocode.sendMessage()` returns the runtime's delivery promise. Await it when handling asynchronous preparation failures. Acceptance can mean the message is queued; it does not acknowledge that the model has seen it or that a transcript receipt is durable.

For auxiliary model requests, capture `const recordUsage = octocode.createUsageRecorder("my-request")` before starting asynchronous work and pass each returned assistant message to it before deciding whether to accept the response. It records reported nonzero usage in the originating session, including unsuccessful responses, and ignores repeat calls with the same message object. Do not also attach that usage to another persisted entry. Storage failures throw so the caller can stop rather than silently omit accounting.

<a id="custom-ui"></a>
<a id="mode-behavior"></a>
<a id="interact-with-the-user"></a>
<a id="account-for-each-mode"></a>

## UI and modes

`ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor access, and custom components.
Use `ctx.ui.custom()` only when the interaction needs its own rendering and input.
`ctx.ui.select()`, `confirm()` and `input()` take `signal` and `timeout`, plus two flags that tell remote clients what the dialog is. Pass `approval: true` to a `select` or `confirm` that decides whether to allow an action, so the web page shows an approval, not a question, and RPC hosts receive `approval: true` on the `extension_ui_request` (the web page counts every `confirm` as an approval; RPC hosts see the flag only when it is passed; Octocode's permission prompts set it). Pass `blocking: true` when the dialog holds up work that goes on without the user, such as a background agent's approval: it is then reported as waiting, on the web page and in `octocode remote list` (which shows the dialog's title), even when no run is active, and stays reported after the run settles, whereas a picker opened while idle is not reported. RPC hosts do not receive `blocking`. The `ui_prompt_start` event carries both flags, and its `id` is repeated by `ui_prompt_end`. Dialogs share one slot: opening another dialog, a built-in selector, a custom component or a custom editor, or a reload or session replacement that resets the extension UI, answers the open one with no value, so `select()`, `input()` and `editor()` resolve `undefined` and `confirm()` resolves `false`. `ctx.ui.custom()` resolves `undefined` in the same cases, overlays included, and its component is always disposed once, also when the factory calls `done` before it returns. `ctx.ui.notify()` text is shown without terminal control sequences, so escape codes in it are stripped.
See [Terminal UI](tui.md) for component, focus, overlay, theme, and performance guidance.

Extensions load in interactive, RPC, JSON, and print modes.
Interactive mode provides the complete terminal UI.
RPC can forward supported dialogs and notifications through the RPC Extension UI protocol, but not custom terminal components; JSON and print modes have no UI.
Guard terminal-only behavior with `ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients.

Keep tool and event behavior independent from rendering so non-interactive modes remain functional.

<a id="error-handling"></a>
<a id="handle-errors-and-shutdown"></a>

## Errors and cleanup

Octocode reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model.

Release resources in `session_shutdown` even when normal operation attempted cleanup.
Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path.
Use `ctx.shutdown()` to request an orderly process shutdown.
