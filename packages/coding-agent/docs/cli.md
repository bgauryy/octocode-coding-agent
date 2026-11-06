# CLI Modes

`octocode --help` lists every command and flag, and shell completion comes from `octocode completion <bash|zsh|fish>`. This page covers how Octocode picks an output mode and what each non-interactive mode writes.

## Choose a mode

| Invocation                                                   | Mode         | Output                                                                               |
| ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------ |
| `octocode` in a terminal                                     | Interactive  | The terminal UI.                                                                     |
| `octocode -p "prompt"`, or stdin or stdout is not a terminal | Text (print) | The final assistant text on stdout; errors on stderr.                                |
| `octocode --mode json "prompt"`                              | JSON         | The session header, then one JSON event per line.                                    |
| `octocode --mode rpc`                                        | RPC          | JSON commands on stdin, JSON responses and events on stdout. See [RPC mode](rpc.md). |
| `octocode --mode acp`                                        | ACP          | Agent Client Protocol v1 for editors. See [ACP](acp.md).                             |

`--mode rpc` and `--mode json` win over `--print`. Content piped on stdin is added to the initial message and switches an interactive start to text mode. Octocode reads a stdin pipe to its end before starting, even with a prompt on the command line, so a parent that leaves the pipe open holds the run: after a few seconds one line on stderr says so, and the wait has no deadline. Pass `--no-stdin` to skip reading it. RPC mode reads stdin for commands, so it ignores piped content and refuses `@file` arguments.

```bash
octocode -p "List the TypeScript files in src/"
git diff | octocode -p "Review this diff"
octocode --mode json --no-session "Summarize README.md" > events.jsonl
```

## Text mode

Text mode sends the initial message and any further positional messages as separate prompts, then prints the text blocks of the last assistant message. Octocode exits with `1` when a prompt ends in an error or abort, or when the reply was cut at the model's output limit. A request failure is also reported on stderr. The verdict comes from the run's recorded outcome (`status`, `errorMessage`, `usage`), so a failure recovery could not repair, such as a context overflow with nothing left to summarize, still exits `1` with its reason. A provider retry writes one line on stderr saying how long it waits.

## JSON mode

JSON mode runs the same prompts and writes JSON Lines to stdout: first the session header, then each session event as it happens (`agent_start`, `message_update`, `tool_execution_end`, `agent_end`, `agent_settled` and so on). `agent_settled` carries the run's `outcome`. Streaming `message_update` events carry the delta and cumulative `usage`, not the whole message; `message_end` holds the finished message. The event types are `AgentSessionEvent` in [`src/core/agent-session/types.ts`](../src/core/agent-session/types.ts) and the wire shape is `toJsonEvent` in [`src/modes/json-event.ts`](../src/modes/json-event.ts). The exit code follows the same rule as text mode, and other stdout writes go to stderr so the stream stays parseable. The protocol records of RPC mode use the same event shape.

## Flags that shape a run

The groups below name the flags; `octocode --help` has the exact syntax.

- **Model**: `--model` (accepts `provider/id` and a `:thinking` suffix), `--provider` (for the auth commands, or a bare `--model` id), `--models` for the cycling list, `--thinking`, `--list-models`.
- **Permissions**: `--permission-mode manual|workspace|full` picks the start mode; `--dangerously-skip-permissions` starts in `bypass`, where nothing asks and every call is still recorded. Subagents inherit either. See [permissions](permissions.md#modes).
- **Sessions**: `--continue`, `--resume`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `--name`, `--export`, `--worktree <name>` (start in a git worktree of this repository; see [worktrees](native-features.md#worktrees)).
- **Planning**: `--plan` starts with the planning constraint on (read-only until you approve a plan; see [native planning constraint](native-features.md#native-planning-constraint)).
- **Tools**: `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `--no-mcp`. See [native features](native-features.md#tool-selection-and-migration).
- **Resources**: `--skill`, `--prompt-template`, `--theme` and their `--no-…` forms, `--no-context-files`. User code extensions are not supported, and their flags (`--extension`, `-e`, `--no-extensions`) are unknown options. Built-in features switch through the `extensions` setting (`-builtin:mcp`) or `--no-mcp`.

An unknown `--flag` fails at startup with `Unknown option: --flag` and a pointer to `octocode --help`; features cannot register flags of their own, so the table that `--help` and shell completion read lists every flag.

Every flag has one long name. The only short forms are single letters: `-p`, `-c`, `-r`, `-n`, `-t`, `-h` and `-v`.

- **Trust and network**: `--trust` records your trust of the current folder and then runs; a print, JSON or RPC run in a folder you have not trusted exits with an error without it (it does not apply to `--mode acp`). `--offline`. See [permissions](permissions.md) and [environment variables](environment-variables.md).
- **Headless**: `--no-stdin` (do not read piped stdin), `--no-dialogs` (RPC mode: no one answers dialogs, so asks are refused as in a print run; see [RPC mode](rpc.md#protocol)).
- **Interface**: `--tui-mode`, `--use-theme`, `--verbose`.

When `--continue`, `--session` or `--session-id` opens a saved session that another running Octocode process has open, Octocode asks whether to resume it here as well, as `/resume` and `--resume` do; Cancel exits. Print, JSON and RPC modes cannot ask, so they exit with an error instead: two processes appending to one session overwrite each other's history. `--fork` copies the session and is never refused. `--session-id <id>` and `--fork --session-id <id>` refuse an id that belongs to a saved session in another folder and name its file; use `--session <id>` to open it.

`--session <id>` with an id saved in another project folder offers to fork it here. Print, JSON and RPC modes cannot ask, so they exit `1` and name `--fork <id>`, leaving stdin unread; `--resume` opens a picker and exits `1` the same way. A prefix of `--session` or `--fork` that matches several sessions exits `1` and lists them. A match in this project wins over matches elsewhere.

If a write to stdout fails in print, JSON or RPC mode, for example `octocode --mode json "…" | head -1`, Octocode releases the session and exits `1` with one line on stderr.

Settings supply defaults for most of these; see [settings](settings.md). Environment variables that change behavior are listed in [environment variables](environment-variables.md).
