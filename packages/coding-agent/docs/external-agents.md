# Use Octocode from another agent

Octocode can run as a headless coding and research worker. A parent agent, script or CI job starts `octocode` in the target project, gives it a bounded task and checks the result. No terminal UI is required.

## Choose an interface

| Need | Interface | Completion signal |
| --- | --- | --- |
| One task, final answer as text | `octocode -p "task"` | Process exit and stdout |
| One task, streamed progress and tool results | `octocode --mode json "task"` | JSON Lines events and process exit |
| A persistent session with prompts, steering and cancellation | `octocode --mode rpc` | Correlated responses and `agent_settled` events |
| An editor or agent host that speaks ACP | `octocode --mode acp` | [ACP protocol](acp.md) |

Start with text mode for simple delegation. Use JSON for progress tracking, or RPC when the caller needs to control a running session. To reach an already-running session instead of spawning one, see the [session API](session-api.md).

## Prepare the worker

1. [Install Octocode](../README.md#install-and-first-run) and run `octocode --version` to confirm which executable is on `PATH`. The coding agent and the separate Octocode research package share the `octocode` command name.
2. Configure [provider credentials](providers.md): sign in interactively before automation, or inject a provider API key through the environment or your secret manager. Do not put keys in task text, command arguments or committed project settings. Use a model whose provider plan permits unattended use.
3. Run `octocode --list-models` and choose an available `provider/model-id`. Pass it with `--model` to avoid depending on an interactive model choice or changing defaults.
4. Review the target project, then explicitly grant folder trust with `octocode trust add /path/to/project`. Alternatively, `--trust` records trust and starts the run. Neither option is a sandbox: trusting a folder enables its instructions, settings, hooks and MCP configuration.
5. Choose a [permission mode](permissions.md#modes). The examples use `workspace`; it permits routine shell, web, MCP and subagent work, but refuses actions needing approval when no UI can answer. It does not confine shell commands to the project. The default is the broader `full` mode. Use an isolated checkout or container when the task needs filesystem or network confinement.

Headless runs load the same trusted project configuration and instructions as terminal sessions. Run-specific flags override settings without rewriting them; see [automation configuration](configuration.md#headless-and-external-agent-runs).

## Delegate one task

Run these commands in the trusted target project, with credentials already available. Set `MODEL` to an available model selected above:

```bash
octocode -p --no-stdin --no-session --permission-mode workspace --model "$MODEL" \
  "Find the cause of the failing tests. Do not edit files. Report evidence and the command to reproduce."
```

`--no-stdin` prevents a parent process's open input pipe from holding startup. Text mode writes the final assistant answer to stdout and diagnostics to stderr. A failed, aborted or output-truncated run exits `1`; do not treat partial output from such a run as success. An exit of `0` means the agent run completed, not that its proposed fix or conclusions were independently verified.

To supply task text or a diff through stdin, **omit `--no-stdin` and close the pipe**:

```bash
git diff | octocode -p --no-session --permission-mode workspace --model "$MODEL" \
  "Review this diff for correctness bugs. Do not edit files."
```

`--no-session` keeps the conversation in memory rather than saving a resumable transcript. It does not disable tool side effects, audit records or other runtime state. Omit it if recovery or follow-up is needed; use a distinct `--session-id` per independent worker, or `--session <id>` for a later one-shot follow-up. Never have two processes write the same session. Use `--fork <id>` for independent work from existing context.

### Spawn safely from a program

Use an argument array, not a shell command assembled from task text. This standalone Node example for macOS/Linux accepts a project, a model and one task. It sends the task over stdin, so task text is not parsed as CLI flags or `@file` arguments, and closes stdin immediately. Save it as `delegate.mjs`:

```javascript
import { execFileSync } from "node:child_process";

const [cwd, model, task] = process.argv.slice(2);
if (!cwd || !model || !task) {
  throw new Error('Usage: node delegate.mjs <project> <provider/model> "task"');
}

try {
  const answer = execFileSync(
    "octocode",
    ["-p", "--no-session", "--permission-mode", "workspace", "--model", model],
    {
      cwd,
      input: task,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  process.stdout.write(answer);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
```

On Windows, launch `node` with the absolute path to the installed Octocode `cli.js` as its first argument instead of executing an npm `.cmd` shim; keep shell execution disabled.

This buffers the final answer and blocks this wrapper process until the child exits. For concurrent workers or live progress, use an asynchronous subprocess and continuously drain both stdout and stderr. Apply a caller-owned deadline and output budget; treat launch errors, signals, timeouts and nonzero exits as failures rather than retrying a potentially mutating task blindly.

## Stream machine-readable progress

```bash
octocode --mode json --no-stdin --permission-mode workspace --model "$MODEL" \
  "Run the relevant tests and report failures without editing files."
```

The output is **JSON Lines**, not one JSON document and not a guaranteed task-specific JSON schema. Parse complete LF-delimited lines, retaining a partial line across chunks. The first record is the session header; subsequent records include `message_update`, `message_end`, `tool_execution_end` and `agent_settled`.

Use `agent_settled.outcome.status` for the run verdict (`completed`, `failed`, `aborted` or `truncated`), and check the process exit too. The outcome includes usage; keep stderr separate from protocol output. Tool failures can be recovered by the model, so neither one failed tool nor an earlier `agent_end` replaces the settled outcome. If your application requires structured domain data, request a schema in the task and validate the returned answer separately.

## Control a persistent session with RPC

Start the process with piped stdin/stdout and a separate stderr reader:

```bash
octocode --mode rpc --no-dialogs --permission-mode workspace --model "$MODEL"
```

This is a process for a driver to control, not a one-shot command to feed with `echo ... | octocode`. The [RPC reference](rpc.md) defines framing, commands and responses.

1. Read the `rpc_ready` record and check `protocolVersion` before using a protocol version your driver does not support.
2. Write one JSON command followed by LF. Give each command a unique `id`.
3. For a completed-task response rather than an acceptance acknowledgement, send:

   ```json
   {"id":"task-1","type":"prompt","message":"Investigate the failing test; do not edit files.","waitForCompletion":true}
   ```

4. Continue reading responses and events. Match the response by `id`, check `success`, then check `data.outcome.status`. `success: true` means the command succeeded; the run itself can still have failed. Retrieve final text with `get_last_assistant_text` if needed.
5. Keep stdin open until the completion response or the relevant `agent_settled` event. Closing stdin aborts active work and can exit `0` even if the result never arrived; EOF is not proof of completion.
6. Send another prompt to continue the session, or `abort` to cancel. Close stdin only when finished and wait for process exit.

`--no-dialogs` refuses asks instead of waiting for answers. If your driver can handle approvals and questions, omit it and implement the UI request/response protocol; `--rpc-ask` selects typed question batches. Without a response, a dialog can block indefinitely. Do not combine RPC with `--no-stdin`: stdin is its command channel.

## Delegate effectively

| Caller decision | What to provide or check |
| --- | --- |
| Task scope | Objective, relevant files or evidence, constraints, expected output and a command that proves completion |
| Authority | Whether edits, network requests, subagents or destructive actions are allowed; enforce restrictions through tools and permissions, not task wording alone |
| Context | Let Octocode read the project; send the specific failure or diff instead of duplicating an entire repository or conversation |
| Tools | Use [tool selection](native-features.md#tool-selection-and-migration) to limit capabilities; `--tools` alone does not restrict a subagent's profile tools |
| Parallel work | Separate sessions; separate worktrees for overlapping edits; never assume independent processes coordinate writes automatically |
| Recovery | Preserve the session for follow-up; inspect changes and the last outcome before retrying a timed-out or interrupted task |
| Acceptance | Validate the returned data, review the diff and run the agreed checks; the parent remains responsible for the result |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Waiting before any model activity | Parent left stdin open: close it after input, or use `--no-stdin` for text/JSON |
| Startup refuses the project | Grant trust explicitly after reviewing it; headless mode cannot ask |
| Missing credentials or model | Check the worker's environment and global configuration; it may differ from your terminal |
| Permission-denied tool result | The mode or a rule requires approval; use an approval-capable RPC driver or narrow the task, not blanket bypass |
| JSON parsing fails | Parse JSONL by complete lines; do not combine stderr with stdout |
| RPC exits without a result | Wait for completion before closing stdin; check the run outcome, not only exit status |
| Follow-up cannot find the session | Remove `--no-session` when recoverability is required and keep a stable session id |
