# RPC Mode

<!-- This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references. -->

`octocode --mode rpc` runs one headless session controlled over stdin and stdout. Use it to embed Octocode in another program; see [CLI modes](cli.md) for the other modes. SDK users can call the typed `RpcClient`, which spawns the process and wraps these commands.

Each line on stdin is one JSON command, and each line on stdout is one JSON record. Framing is LF only: split on `\n`, not on other Unicode line separators, which may appear inside strings. Octocode refuses `@file` arguments in this mode. It takes over stdout for protocol records and redirects other stdout writes to stderr.

## Protocol

Every command has a `type` and an optional string `id`. A response repeats the `id` and names the `command` it answers:

- Success: `{"type":"response","command":"get_state","success":true,"data":{...}}`. `data` is omitted for commands that return nothing.
- Failure: `{"type":"response","command":"…","success":false,"error":"…"}`. A line that is not JSON answers with `command: "parse"`; an unknown or malformed command answers with its `type` and names the field at fault.
- `prompt` answers as soon as the input is accepted (`data.disposition`); it does not wait for the run. Follow progress through events, or set `waitForCompletion` to answer after the run, in which case a busy session replies with `execution: "not-sent"` and sends nothing.

Session events stream as they occur, without a request: `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `turn_end`, `agent_end` and `agent_settled`, plus `queue_update`, `compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end` and other session records. Streaming `message_update` events carry only the delta and the cumulative `usage`; the finished message arrives in `message_end`. The types are `AgentSessionEvent` in `src/core/agent-session/types.ts` and `toJsonEvent` in `src/modes/json-event.ts`.

Extensions that need input emit `extension_ui_request` records (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`). Answer `select`, `confirm`, `input` and `editor` with an `extension_ui_response` line carrying the request `id` and a `value`, `confirmed` or `cancelled: true`. Extension failures arrive as `extension_error`. A `setStatus` record carries `statusKey`, plain `statusText` (absent to clear) and, when the extension gave one, `statusTone` (`accent`, `muted`, `dim`, `success`, `warning` or `error`) for the client to colour in its own palette.

The process exits when stdin closes, on `SIGTERM` or `SIGHUP` (`SIGTERM` only on Windows), or after an extension requests shutdown, once the current command or run settles. Pending extension requests are cancelled first.

## Commands

| Command | Fields | Description |
|---|---|---|
| `prompt` | `message`: string<br>`images?`: object[]<br>`streamingBehavior?`: "steer" \| "followUp"<br>`waitForCompletion?`: boolean<br>`dispatchId?`: string | Send a message. During a run, `streamingBehavior` queues it as `steer` or `followUp`. `dispatchId` correlates extension-dispatched work when `waitForCompletion` is set. |
| `steer` | `message`: string<br>`images?`: object[] | Queue a message delivered while the agent is running. |
| `follow_up` | `message`: string<br>`images?`: object[] | Queue a message for after the agent stops. |
| `abort` |  | Stop the current run. |
| `clear_queue` |  | Drop all queued steering and follow-up messages; returns what was dropped. |
| `get_queue` |  | List queued inputs with their `queueId` values. |
| `edit_queued` | `queueId`: string<br>`text`: string | Replace the text of a queued input; `data.outcome` is `replaced`, `removed` or `missing`. |
| `remove_queued` | `queueId`: string | Remove one queued input. |
| `move_queued` | `queueId`: string<br>`direction`: "up" \| "down" | Move a queued input up or down. |
| `new_session` | `parentSession?`: string | Start a new session, optionally linked to a parent session file. |
| `plan` | `action`: "show" \| "enter" \| "leave" \| "approve"<br>`revision?`: integer | Show, enter, leave or approve plan mode; `revision` pins the plan revision to approve. |
| `get_state` |  | Model, thinking level, streaming and compaction flags, queue modes, session identity and message counts. |
| `set_model` | `provider`: string<br>`modelId`: string | Select a model by provider and ID from the available models; fails if it is not available. |
| `cycle_model` |  | Switch to the next model; `data` is `null` when there is nothing to cycle. |
| `get_available_models` |  | List the available models. |
| `set_thinking_level` | `level`: "off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" | Set the thinking level. |
| `cycle_thinking_level` |  | Switch to the next thinking level the model supports. |
| `get_available_thinking_levels` |  | List the levels the current model supports. |
| `set_steering_mode` | `mode`: "all" \| "one-at-a-time" | Deliver queued steering messages `all` at once or `one-at-a-time`. |
| `set_follow_up_mode` | `mode`: "all" \| "one-at-a-time" | Deliver queued follow-up messages `all` at once or `one-at-a-time`. |
| `compact` | `customInstructions?`: string | Run compaction now; `customInstructions` is limited in length by the schema. |
| `set_auto_retry` | `enabled`: boolean | Enable or disable automatic retry of transient failures for this session. |
| `abort_retry` |  | Cancel a pending automatic retry wait. |
| `bash` | `command`: string<br>`excludeFromContext?`: boolean | Run a shell command as the user would with `!`; `excludeFromContext` keeps its output out of the model context. |
| `abort_bash` |  | Stop a command started with `bash`. |
| `get_session_stats` |  | Token, cost and message statistics for the session. |
| `persist_session` |  | Write the session file now; fails when persistence is disabled. |
| `export_html` | `outputPath?`: string | Export the session to HTML; `data.path` is the written file. |
| `switch_session` | `sessionPath`: string | Open another session file. |
| `fork` | `entryId`: string | Fork from a user message entry; `data.text` is that message. |
| `clone` |  | Copy the current branch into a new session. |
| `get_fork_messages` |  | List user messages that can be forked from. |
| `get_entries` | `since?`: string | Session entries, or those after the entry id given in `since`. |
| `get_tree` |  | The session tree and current leaf. |
| `get_last_assistant_text` |  | Text of the last assistant message, or `null`. |
| `set_session_name` | `name`: string | Set the display name; empty names are refused. |
| `get_messages` |  | The message history. |
| `get_commands` |  | Extension commands, prompt templates and skill commands that a `prompt` can invoke. |
