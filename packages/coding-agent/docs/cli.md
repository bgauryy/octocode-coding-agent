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

`--mode rpc` and `--mode json` win over `--print`. Content piped on stdin is added to the initial message and switches an interactive start to text mode. RPC mode reads stdin for commands, so it ignores piped content and refuses `@file` arguments.

```bash
octocode -p "List the TypeScript files in src/"
git diff | octocode -p "Review this diff"
octocode --mode json --no-session "Summarize README.md" > events.jsonl
```

## Text mode

Text mode sends the initial message and any further positional messages as separate prompts, then prints the text blocks of the last assistant message. Octocode exits with `1` when a prompt ends in an error or abort, or when the reply was cut at the model's output limit. A request failure is also reported on stderr.

## JSON mode

JSON mode runs the same prompts and writes JSON Lines to stdout: first the session header, then each session event as it happens (`agent_start`, `message_update`, `tool_execution_end`, `agent_end`, `agent_settled` and so on). Streaming `message_update` events carry the delta and cumulative `usage`, not the whole message; `message_end` holds the finished message. The event types are `AgentSessionEvent` in [`src/core/agent-session/types.ts`](../src/core/agent-session/types.ts) and the wire shape is `toJsonEvent` in [`src/modes/json-event.ts`](../src/modes/json-event.ts). The exit code follows the same rule as text mode, and other stdout writes go to stderr so the stream stays parseable. The protocol records of RPC mode use the same event shape.

## Flags that shape a run

The groups below name the flags; `octocode --help` has the exact syntax.

- **Model**: `--provider`, `--model` (accepts `provider/id` and a `:thinking` suffix), `--models` for the cycling list, `--thinking`, `--list-models`.
- **Sessions**: `--continue`, `--resume`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `--name`, `--export`, `--worktree <name>` (start in a git worktree of this repository; see [worktrees](native-features.md#worktrees)).
- **Tools**: `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `--no-mcp`. See [native features](native-features.md#tool-selection-and-migration).
- **Resources**: `--extension builtin:<id>` (turns a built-in feature on; a code path exits 2 because user code extensions are not supported), `--no-extensions` (accepted and ignored), `--skill`, `--prompt-template`, `--theme` and their `--no-…` forms, `--no-context-files`.
- **Trust and network**: `--trust` records your trust of the current folder and then runs; a print, JSON or RPC run in a folder you have not trusted exits with an error without it (it does not apply to `--mode acp`). `--offline`. See [permissions](permissions.md) and [environment variables](environment-variables.md).
- **Interface**: `--tui-mode`, `--use-theme`, `--verbose`.

When `--continue`, `--session` or `--session-id` opens a saved session that another running Octocode process has open, Octocode asks whether to resume it here as well, as `/resume` and `--resume` do; Cancel exits. Print, JSON and RPC modes cannot ask, so they exit with an error instead: two processes appending to one session overwrite each other's history. `--fork` copies the session and is never refused. `--session-id <id>` and `--fork --session-id <id>` refuse an id that belongs to a saved session in another folder and name its file; use `--session <id>` to open it.

Settings supply defaults for most of these; see [settings](settings.md). Environment variables that change behavior are listed in [environment variables](environment-variables.md).
