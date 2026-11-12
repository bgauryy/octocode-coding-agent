/**
 * Prose for the generated RPC reference. The command list and fields come from `RpcCommandSchema`; this file
 * describes each command, keyed by its `type`.
 */

export const rpcIntro = [
	"`octocode --mode rpc` runs one headless session controlled over stdin and stdout. Use it to embed Octocode in another program; see [CLI modes](cli.md) for the other modes. SDK users can call the typed `RpcClient`, which spawns the process and wraps these commands.",
	"Each line on stdin is one JSON command, and each line on stdout is one JSON record. Framing is LF only: split on `\\n`, not on other Unicode line separators, which may appear inside strings. Octocode refuses `@file` arguments in this mode. It takes over stdout for protocol records and redirects other stdout writes to stderr.",
].join("\n\n");

export const rpcProtocol = [
	'The first record of every session is `{"type":"rpc_ready","protocolVersion":1,"version":"…","sessionId":"…"}`. `protocolVersion` changes only when a change would break an existing driver; `version` is the Octocode version. `get_state` repeats both. Commands sent before startup finishes are held, so a driver need not wait for this record. The `RpcClient` passes it to its `onReady` option, and its `start()` resolves when this record arrives, or rejects when the process exits or fails to start first.',
	"Every command has a `type` and an optional string `id`. A response repeats the `id` and names the `command` it answers:",
	[
		'- Success: `{"type":"response","command":"get_state","success":true,"data":{...}}`. `data` is omitted for commands that return nothing.',
		'- Failure: `{"type":"response","command":"…","success":false,"error":"…"}`. A line that is not JSON answers with `command: "parse"`; an unknown or malformed command answers with its `type` and names the field at fault. A failure with no `id`, such as a `parse` answer, cannot be tied to a command; the `RpcClient` passes it to its `onProtocolError` option and names it in that command\'s timeout. A `prompt` refused because the model has no usable credentials also carries `authRequired: true`.',
		'- `prompt` answers as soon as the input is accepted (`data.disposition`); it does not wait for the run. Follow progress through events, or set `waitForCompletion` to answer after the run, in which case a busy session replies with `execution: "not-sent"` and sends nothing. The answer\'s `data.outcome` says how the run ended: `status` is `completed`, `failed`, `aborted` or `truncated`, with `stopReason`, `errorMessage` and the run\'s cumulative `usage`. A failed run still answers `success: true`, because the command itself succeeded. `agent_settled` carries the same `outcome`, so a driver need not fold `message_end` events. A failure raised after an accepted prompt without `waitForCompletion` arrives as a `{"type":"run_error","id":...,"error":...}` record.',
		'- A `prompt` that starts with a built-in slash command (`/context`, `/btw`, `/diff`, `/compact`, `/configuration` and the other built-in commands; RPC has dedicated commands for some, such as `compact`) fails with `error: "/<name> is available in the interactive terminal only."`; `get_commands` lists only extension commands, prompt templates and skills.',
		'- A native command a `prompt` runs that fails answers `success: false` with its error, beside the `extension_error` event (`event: "command"`). Commands that succeed answer `disposition: "handled"`.',
	].join("\n"),
	"Session events stream as they occur, without a request: `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `turn_end`, `agent_end` and `agent_settled`, plus `queue_update`, `compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end` and other session records. Streaming `message_update` events carry only the delta and the cumulative `usage`; the finished message arrives in `message_end`. While a stdout write is pending, only the latest `tool_execution_update` of each call is kept, since each is a whole snapshot; a slow reader sees fewer updates, and never one after the call's end. Each `tool_execution_start`, `tool_execution_update` and `tool_execution_end` also carries `display`: how the call reads (title, summary, outcome and ordered blocks), built by the tool's `display()` or the generic display, the same data the terminal, web view, HTML export and ACP draw. It is for people; `args`, `partialResult` and `result` stay the model-facing data.",
	"By default each event is whole, so one tool result travels up to five times: in `tool_execution_end`, its `message_start` and `message_end`, `turn_end` and `agent_end`, each time with its `structuredContent` (a bash result's holds up to 1 MiB) and every assistant message's `requestTrace`. A driver that does not need the copies starts the process with `--rpc-lean-events`; a subagent's parent always does. Then `tool_execution_end` carries the result without `structuredContent`, a tool result's `message_start` and `message_end` carry the message without `content`, `details` and `structuredContent` (match it to `tool_execution_end` by `toolCallId`), an assistant `message_end` has no `requestTrace`, and `turn_end` and `agent_end` refer to each message by `role` and `timestamp`, plus `toolCallId`, `toolName`, `isError` and `stopReason` when it has them. User and custom messages and every other event are unchanged.",
	"Dialogs and status updates arrive as `extension_ui_request` records (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`). Answer `select`, `confirm`, `input` and `editor` with an `extension_ui_response` line carrying the request `id` and a `value`, `confirmed` or `cancelled: true`. A `select` request from a client without `--rpc-ask` carries `approval: true` when the dialog decides whether to allow an action (every permission prompt), with that prompt's `permission` and `ask` card; show it as an approval. A `confirm` request never does. A client started with `--rpc-ask` also gets the `ask` method: one request carries `questions`, a batch of typed questions (`text`, `choice`, `multi`, `confirm` or `approval`, each with an `id`, its `options` and their `role`), plus `approval: true` when a question is a permission prompt and `timeout` in milliseconds. An approval from a subagent also carries `header`, a line for its parent to read and never show. Answer with an `extension_ui_response` carrying the request `id` and `replies`, one per question: `{ id, picks }` (option ids, plus `text` for a typed answer or write-in) or `{ id, cancelled }` (`declined`, `aborted`, `unavailable` or `timeout`). A reply that picks an option the question does not offer declines the whole batch, and `cancelled: true` declines it too. Without `--rpc-ask` the process never sends `ask`: the same questions arrive as `select`, `confirm` and `input`. A dialog can end without your response: another client answered it, its run was aborted, or its timeout passed. Octocode then emits an `extension_ui_dismiss` record carrying that request's `id`; close that dialog, because a response sent for it afterwards is ignored. The Octocode `RpcClient` passes the id to its `onExtensionUIDismiss` option. Failures in a command or hook arrive as `extension_error`. A `setStatus` record carries `statusKey`, plain `statusText` (absent to clear) and, when one was given, `statusTone` (`accent`, `muted`, `dim`, `success`, `warning` or `error`) for the client to colour in its own palette.",
	"A dialog blocks its run until it is answered, with no timeout. A driver that answers nothing should start the process with `--no-dialogs`. The session then runs with no UI, as a print run does: a permission ask gets the same refusal, with its reason, and no `extension_ui_request` records are emitted, including `notify` and `setStatus`.",
	"The process exits when stdin closes, on `SIGINT` (exit 130), `SIGTERM` (143) or `SIGHUP` (129; `SIGHUP` is not available on Windows), or after an extension requests shutdown. Pending extension requests are cancelled first. These do not wait for a run: closing stdin aborts the current run and exits 0, even if a command sent just before it never ran, so a driver that needs the result keeps stdin open until `agent_settled` or the `waitForCompletion` answer arrives. A requested shutdown waits for the current run to settle.",
	"If a write to stdout fails because the driver closed its end, the session is released and the process exits 1 with one line on stderr; a closed stdout is noticed at the next write. In the default `full` permission mode the process says on stderr at session start that every action runs without asking, and where the record is.",
].join("\n\n");

export const rpcCommandDescriptions: Readonly<Record<string, string>> = {
	prompt:
		"Send a message. During a run, `streamingBehavior` queues it as `steer` or `followUp`. `dispatchId` correlates extension-dispatched work when `waitForCompletion` is set.",
	steer:
		"Queue a message delivered while the agent is running. On an idle session it still answers `queued` and starts nothing: it waits for the next prompt. To avoid that race at the end of a run, send `prompt` with `streamingBehavior`.",
	follow_up:
		"Queue a message for after the agent stops. On an idle session it answers `queued` and starts nothing, as `steer` does.",
	abort: "Stop the current run.",
	clear_queue: "Drop all queued steering and follow-up messages; returns what was dropped.",
	get_queue: "List queued inputs with their `queueId` values.",
	edit_queued: "Replace the text of a queued input; `data.outcome` is `replaced`, `removed` or `missing`.",
	remove_queued: "Remove one queued input.",
	move_queued: "Move a queued input up or down.",
	new_session: "Start a new session, optionally linked to a parent session file.",
	plan: "Show, enter, leave or approve plan mode; `revision` pins the plan revision to approve.",
	get_state:
		"Protocol and Octocode versions, model, thinking level, streaming and compaction flags, queue modes, session identity and message counts.",
	set_model: "Select a model by provider and ID from the available models; fails if it is not available.",
	cycle_model: "Switch to the next model; `data` is `null` when there is nothing to cycle.",
	get_available_models:
		"List the available models. A model whose plan allows interactive use only carries `interactiveOnly: true`.",
	set_thinking_level: "Set the thinking level.",
	cycle_thinking_level: "Switch to the next thinking level the model supports.",
	get_available_thinking_levels: "List the levels the current model supports.",
	set_steering_mode: "Deliver queued steering messages `all` at once or `one-at-a-time`.",
	set_follow_up_mode: "Deliver queued follow-up messages `all` at once or `one-at-a-time`.",
	compact: "Run compaction now; `customInstructions` is limited in length by the schema.",
	set_auto_retry:
		"Enable or disable automatic retry of transient failures for this session. Settings files are not changed, and a new session starts from settings again.",
	abort_retry: "Cancel a pending automatic retry wait.",
	bash: "Run a shell command as the user would with `!`; `excludeFromContext` keeps its output out of the model context. The response data carries what the model gets: `header` (`[exit 0 · 4.2s · 312 lines · 18 KB]`, with what was trimmed and the full-output path when the output exceeded the `bashOutputMaxBytes` budget), the trimmed `output`, `totalLines`, `totalBytes` and `wallTimeSeconds`.",
	abort_bash: "Stop a command started with `bash`.",
	get_session_stats: "Token, cost and message statistics for the session.",
	persist_session: "Write the session file now; fails when persistence is disabled.",
	export_html: "Export the session to HTML; `data.path` is the written file.",
	switch_session:
		"Open another session file. Fails, naming the pid, when another Octocode process has it open: two processes appending to one session overwrite each other's history.",
	fork: "Fork from a user message entry; `data.text` is that message.",
	clone: "Copy the current branch into a new session.",
	get_fork_messages: "List user messages that can be forked from.",
	get_entries: "Session entries, or those after the entry id given in `since`.",
	get_tree: "The session tree and current leaf.",
	get_last_assistant_text: "Text of the last assistant message, or `null`.",
	set_session_name: "Set the display name; empty names are refused.",
	delete_sessions:
		"Delete saved sessions by id: transcript (to the trash when available), session folders and database rows, as the `/resume` picker does. The current session and sessions another process runs come back in `data.refused`; unknown ids in `data.notFound`.",
	purge:
		"Delete this workspace's (`workspace`) or every workspace's and the global (`all`) Octocode data, as `/purge` does. `confirm` is required: `false` deletes nothing and returns the preview in `data.lines`; `true` deletes unless another live Octocode process holds sessions in scope (`data.refused` names it). The current session, settings, credentials and MCP configuration stay.",
	get_messages: "The message history.",
	get_commands:
		"Extension commands (with `argumentHint` when set), prompt templates and skill commands that a `prompt` can invoke.",
};
