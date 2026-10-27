# SDK

`@octocodeai/octocodecode` embeds Octocode in a Node.js or Bun process. It provides direct TypeScript access to the agent, sessions, tools, models, and resources used by the command-line application.

Use the SDK for in-process TypeScript integration. For an isolated subprocess, use `octocode --mode rpc`; the [RPC reference](rpc.md) lists its commands and records, the [RPC types](../src/modes/rpc/rpc-types.ts) define its messages and the [RPC client](../src/modes/rpc/rpc-client.ts) demonstrates the protocol.

```typescript
import { createAgentSession } from "@octocodeai/octocodecode";

const { session } = await createAgentSession();

try {
	await session.bindExtensions({});
	await session.prompt("What files are in the current directory?");
	console.log(session.getLastAssistantText());
} finally {
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}
```

This uses the working directory, discovered resources, stored settings, and configured credentials. `prompt()` resolves when the run finishes.

`bindExtensions({})` starts the extension lifecycle, including MCP connections and native services. Supply UI and command-context bindings when the host supports them. Emit `session_shutdown` before disposal so extensions can release their resources; `session.dispose()` alone does not emit that event.

<a id="session-management"></a>

## Session lifecycle

`createAgentSession()` creates an `AgentSession`. The session owns one conversation, its model and tools, queued messages, compaction state, and extension runtime.

Read current state through `session.messages`, `session.model`, `session.thinkingLevel`, `session.systemPrompt`, and `session.getActiveToolNames()`.

`session.systemPrompt` is read-only and returns the current effective system prompt, including changes that have not yet been sent to the model. Tool changes are declared to the model before the next request.

<a id="sessionmanager-api"></a>

### Session storage

Sessions are persistent by default. `SessionManager` owns the persisted or in-memory entry tree and tracks its active leaf. Branching changes that leaf without deleting abandoned branches. When Octocode reconstructs model context, the manager selects the active branch and applies compaction.

`SessionManager` is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.

Use an in-memory manager when the host does not want session files:

```typescript
import { createAgentSession, SessionManager } from "@octocodeai/octocodecode";

const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});
```

For creating, opening, continuing, listing and forking sessions, use the exported TypeScript declarations or [`session-manager.ts`](../src/core/session-manager.ts). That module also defines persisted JSONL entries; [`messages.ts`](../src/core/messages.ts) defines coding-agent transcript additions.

`cwd` selects the workspace used for project resource discovery, context files, session grouping, and built-in tool paths. Pass it explicitly when the target differs from `process.cwd()`.

`session.dispose()` aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners. Call it when the session is no longer needed.

`AgentSessionRuntime` adds `newSession()`, `switchSession()`, `fork()`, and `importFromJsonl()`. Each operation replaces the active `AgentSession` and recreates services for the target working directory.

After a runtime replacement, subscriptions belong to the old `AgentSession` and must be rebound. [`AgentSessionRuntime`](../src/core/agent-session-runtime.ts) provides a rebind callback and an asynchronous `dispose()` that emits shutdown before disposing its session.

## Prompting

`prompt()` handles extension commands and expands file-based prompt templates before ordinary user messages enter the agent. For an accepted agent run, it resolves after the run finishes, including automatic retries.

A prompt sent while the session is already streaming must specify whether it should steer the current run or follow it. Calling `prompt()` without that choice rejects rather than guessing.

A steering message enters after the current assistant turn and its tool calls. A follow-up enters after the current run finishes its pending work. `steer()` and `followUp()` expose those behaviors directly and return `"queued"` if the input was queued (including after an extension transformed it), or `"handled"` if an extension consumed it.

`abort()` stops the active operation and waits for the session to become idle. Its default reason, `interrupted`, emits the observational `agent_interrupted` event for an active turn. Runtime owners can pass `replacement`, `shutdown` or `internal` for cancellation that should not emit it. The first cancellation reason wins for that run. `waitForIdle()` waits without aborting it.

## Subscribing to events

Subscribe before prompting when the host needs streamed output:

```typescript
const unsubscribe = session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

try {
	await session.prompt("Explain this repository");
} finally {
	unsubscribe();
}
```

Session events report message updates, tool execution, queues, compaction, retries, and run lifecycle changes.

`message_end` contains the authoritative completed message. `agent_end` marks the end of one low-level agent run, but automatic recovery or queued work can still follow.

Use `agent_settled` when the host needs to know that Octocode will not continue automatically.

## Configuring a session

Without overrides, the factory creates a `ModelRuntime`, file-backed `SettingsManager`, persistent `SessionManager`, `DefaultResourceLoader`, and the configured default tools.

The factory infers `session_start.reason` as `resume` when the supplied manager contains restored messages or refers to an existing session file, including a saved header-only session. A new, unflushed session starts with `startup`. An explicit `sessionStartEvent` takes precedence, preserving fork, new-session and reload lifecycle reasons.

Each boundary can be supplied explicitly:

- `modelRuntime`, `model`, `thinkingLevel`, and `scopedModels` control model access and selection.
- `settingsManager` supplies merged settings or an in-memory configuration.
- `sessionManager` supplies persistent or in-memory conversation history.
- `resourceLoader` supplies extensions, skills, prompt templates, themes, and context files.
- `tools`, `noTools`, `excludeTools`, and `customTools` control the active tool set.

Project trust: a `SettingsManager` that was not told the project is trusted treats it as untrusted. The default `SettingsManager.create(cwd, agentDir)`, and so a default `createAgentSession`, therefore loads no project settings, project MCP servers (`.octocode/mcp.json` and the other project MCP files) or other trust-gated project resources, and refuses to write project settings. Pass `SettingsManager.create(cwd, agentDir, { projectTrusted: true })` only after your application established trust, or `SettingsManager.createForStartup(cwd, agentDir)` to follow the user's saved `/trust` decision. The CLI resolves trust itself and is unchanged. Earlier versions treated an unspecified project as trusted.

`cwd` and `agentDir` select workspace and user resources. See [configuration locations and precedence](../../../CONFIGURATIONS.md). When supplying a loader or settings manager, construct it with the same directories as the session.

Use `DefaultResourceLoader` when you want standard discovery with selected overrides. Its `nativeFeatures` option defaults to `true`, so CLI and default SDK sessions both load native Octocode features and the built-in extensions. Set `nativeFeatures: false` on the loader for a host that supplies its own tool policy; it is not a `createAgentSession()` option. Supply a custom `ResourceLoader` when the host owns resource storage and discovery completely.

`DefaultResourceLoaderOptions.skillResourceSnapshot` adopts an accepted `SkillResourceSnapshot` as the authoritative skill inventory. It bypasses skill paths, default/plugin skill discovery and `skillsOverride`; other resource systems retain their normal loading behavior. The snapshot validates version, size, metadata and canonical file identities. It contains metadata and paths, not skill file bytes. Invalid snapshots fail rather than falling back to default skills. Obtain a snapshot from the bound extension API's `getSkillResourceSnapshot()`; the native child launcher manages its private transport and cleanup.

<a id="inlineextension"></a>

Inline extension factories can be supplied through `DefaultResourceLoader.extensionFactories`. Give one an `InlineExtension` name when it needs a stable name in diagnostics and startup output. A named inline extension with `replaceable: true` is left out when another extension registers a tool, command, or flag with a name it registers during loading, instead of both loading with a conflict. The built-in tool-search and MCP extensions are replaceable.

A named entry with `builtin: true` supplies the code of a `builtin:<name>` extension, which loads like a configured extension file. It loads by default, is listed in `octocode config`, and is disabled by `-builtin:<name>` in the `extensions` setting or by `noExtensions`; `additionalExtensionPaths: ["builtin:<name>"]` loads it explicitly. It loads after project trust is resolved, so it cannot handle `project_trust`. The standard loader's built-in extensions use this form.

`discoverAndLoadExtensions(paths, cwd, agentDir?, eventBus?, { projectTrusted? })` loads extensions without a resource loader: global extensions, the given paths and, for a trusted project, `.octocode/extensions/` in `cwd`. Directories are scanned with the [CLI discovery rules](extensions.md#extension-directory-discovery) (dot entries, `node_modules`, ignored paths and plugin/skill-marker directories are skipped). Without `projectTrusted` it reads the user's saved trust decision, so an untrusted checkout's extension code does not run; pass `projectTrusted: true` only after your application has established trust.

### MCP

The default resource loader includes `tool_search` and MCP. A custom loader with `nativeFeatures: false` can supply `createToolSearchExtension()` and `createMcpExtension()` explicitly. `createMcpExtension({ presets: [octocodePreset()] })` opts into the Octocode default; both factories and the `McpServerPreset` type are exported from `@octocodeai/octocodecode`. Presets supply default configuration, exposure, launch and presentation policies while the host owns every connection. Omitting presets leaves only configured and extension-registered servers. The low-level client is exported separately from `@octocodeai/octocodecode/mcp`; see the [client API reference](../../mcp/README.md).

MCP defaults to direct exposure: connected tools supply full descriptions and input schemas without discovery, and the server section includes shared instructions once. Explicit `auto` opts into the catalog-size heuristic; explicit `deferred` exposure activates `tool_search`. Discovered tools are called natively through the session pipeline.

MCP starts on `session_start`, emitted by `await session.bindExtensions({})`. Connections may continue in the background; calls wait for the servers they need. On shutdown, emit `session_shutdown` before disposing the session, as in the opening example. See [MCP](mcp.md) for configuration and lifecycle.

## Process clients

The exported `RpcClient` controls an Octocode RPC subprocess. Its `invocation: { command, args }` option supplies an executable and argument prefix before RPC flags, taking precedence over `cliPath`. `onClose(listener)` reports unexpected exit and explicit stop, so hosts can settle pending work; remove listeners with the returned unsubscribe function. See the [RPC client types](../src/modes/rpc/rpc-client/types.ts).

`onEvent`, `collectEvents` and `promptAndWait` use `RpcEvent`, which includes serialized session events and the existing `extension_error` notification (`extensionPath`, `event`, `error`). Narrow by `type` before accessing event-specific fields. Extension UI requests have their separate subscription. The internal `onSessionIdentity` option carries ACP worker startup identity; it is not an application event or a general RPC readiness signal.

`RpcClient.prompt(text, images?, streamingBehavior?, options?)` normally returns the initial prompt disposition. A `handled` command can still dispatch asynchronous work through an extension. Pass `{ waitForCompletion: true, dispatchId: "request-1" }` as the fourth argument to wait for that work, including nested sends and deferred follow-ups. The wire `prompt` command accepts the same optional fields; `dispatchId` is a nonempty string of at most 128 characters. Completion-aware calls refuse a busy session with `execution: "not-sent"` and do not queue or replay the prompt. They have no client response deadline; the host owns cancellation and process shutdown.

`RpcClient.promptAndWait(text, images?, timeoutMs?)` uses completion-aware dispatch and returns the collected events, including for commands that start no model run. Its default timeout is 60 seconds. A timeout removes the request waiter and event subscription; it does not abort or replay the underlying work. Call `abort()` explicitly when the host intends to stop it. The lower-level `collectEvents()` helper still ends on `agent_settled` and is not a command-completion primitive.

Session subscribers and RPC clients also receive `session_dispatch` with `active` and `dispatchId`. This boundary begins before asynchronous input preparation and ends after tracked work finishes, so it can include handled commands with no model run and work started outside a client prompt. It complements model events such as `agent_settled`; it is host dispatch metadata, not an extension hook. The ACP adapter uses it to correlate prompt completion and relay independently started API or team work.

RPC mode validates every stdin line against `RpcCommandSchema` ([schema](../src/modes/rpc/rpc-command-schema.ts)), the TypeBox definition from which `RpcCommand` is derived, before dispatching it. An invalid line is answered with `{ id?, type: "response", command, success: false, error }` and never reaches the session. `command` is the supplied `type` (`"invalid"` when the line is not an object or has no string `type`), `id` is echoed when it is a string, and `error` is `Unknown command: <type>` for an unknown type or names the bad field, such as `Invalid "set_model" command: missing required field "modelId"`.

Queued messages are owned by `AgentSession`: `getQueuedInputs()` lists them in delivery order with an `id`, kind (`steer` or `followUp`), text, attachment count and source; `replaceQueuedInput(id, text)` (empty text removes the message), `removeQueuedInput(id)` and `moveQueuedInput(id, "up" | "down")` change them without touching other queued messages, including extension custom messages. Each call reports `"missing"`, `undefined` or `false` once delivery has begun. Every change emits `queue_update`. Over RPC the same operations are `get_queue`, `edit_queued`, `remove_queued` and `move_queued` (`RpcClient.queue`); `clear_queue` still clears everything. The terminal `/queue` manager is the only interactive editor: the web view displays queue changes from `queue_update` but has no editing controls, and ACP does not expose the queue.

`ownProcessTree: true` makes the client own the worker and its descendants, using the existing process-tree cleanup with a ten-second graceful shutdown period. Ordinary RPC clients retain their existing direct-process stop behavior. [Inbound ACP](acp.md) enables tree ownership and runs one RPC worker per ACP session; its broker is a CLI adapter, not an additional exported SDK session factory.

<a id="exports"></a>

## Resources

- [Choose a Model](models.md) covers model selection and compatible endpoints; [Providers](providers.md) covers credentials and provider-specific setup.
- [Configuration](configuration.md) explains normal discovery; the generated [settings schema](../schemas/settings.schema.json) describes settings.
- [Session storage](#session-storage) covers persistence and the source contracts.
- [Extensions](extensions.md), [Skills](skills.md), and [Prompt Templates](prompt-templates.md) document resources supplied through a `ResourceLoader`.
- [Extension fixtures](../examples/extensions/README.md) demonstrate API behavior used in regression tests.
- [`CreateAgentSessionOptions`](../src/core/sdk.ts) and [`AgentSession`](../src/core/agent-session.ts) define the current SDK surface.

## Session workflow operations

The session exposes the terminal workflows through host methods where no dialog is required:

```typescript
await session.compact({ customInstructions: "Preserve the migration checklist and failing tests." });
const answer = await session.askSideQuestion("Which option did we choose?");
const context = session.getContextReport();
const modelCapacity = session.getContextWindowLimit();
session.setContextWindow(32_000);
session.setContextWindow(); // Reset to the selected model's full catalog capacity.
const changes = await session.getRepositoryDiff("src/parser.ts");
await session.controlPlan({ action: "enter" });
const plan = await session.controlPlan({ action: "show" });
await session.controlPlan({ action: "approve", revision: plan.revision });
```

`controlPlan` requires native features. Its actions are `show`, `enter`, `leave`, and `approve`; approval requires a current positive revision and submits an implementation request. A saved active planning constraint is enforced on direct shell execution and cannot start a model run without the native policy. `stopActiveWork()` aborts the current agent operation and waits for direct shell execution to drain; native planning additionally stops native background work.

`askSideQuestion` uses the injected model stream function and an independent request ID and abort controller. It does not execute tools or persist question/answer text; session accounting includes its usage receipts. The current tool-free request may require a different provider cache prefix. SDK transports must support concurrent calls or reject them explicitly. The context report and repository diff are read-only snapshots; see the [native feature guide](native-features.md#session-workflow-commands) for bounds and interpretation.

`setContextWindow(tokens?)` changes the selected physical model's working context budget for the current session. It requires an idle session and accepts integer token counts from the smaller of 8,192 or the catalog capacity up to that capacity. The budget affects request output clamping, context reporting and automatic compaction; it does not expand the provider's capacity or change catalog metadata. Budgets are remembered separately per model while switching models in the session, and are not persisted on restart or session replacement. Select a physical model before setting its budget; these budgets do not override routes chosen by a virtual model. `getContextReport()` distinguishes the effective `capacity` from `catalogCapacity`, which is `null` for virtual selections.

RPC `compact` accepts optional `customInstructions` (maximum 16,000 characters); old calls remain valid. `RpcClient.compact(options?)` passes it through. Native planning has a structured command:

```json
{"id":"plan-1","type":"plan","action":"enter"}
{"id":"plan-2","type":"plan","action":"show"}
{"id":"plan-3","type":"plan","action":"approve","revision":1}
```

Successful responses carry `data: { active, revision, text }`; unsupported native features or stale revisions produce normal RPC errors. `RpcClient.plan(options)` implements these requests. The [RPC schema](../src/modes/rpc/rpc-command-schema.ts) and [response types](../src/modes/rpc/rpc-types.ts) own the wire contract. RPC `get_commands` includes resolved `aliases` for registered extension/native commands. Core terminal aliases do not create new machine operation names. Side-question, context and diff host methods are not browser or RPC operations.
