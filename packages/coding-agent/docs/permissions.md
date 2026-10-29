# Permissions

Octocode's permission owner decides whether an action needs approval. These checks are separate from operating-system sandboxing. Native modes do not change the process's filesystem or network privileges.

Set `OCTOCODE_PERMISSION` to `manual`, `workspace` or `full` at startup; the default is `full`. `/permissions` manages native approvals. The [native mode table](../src/octocode/permission/mode.ts) defines which action classes ask in each mode. Reservations, protected state, file review and other tool invariants remain in their owning tools.

A mode change that makes some action ask where it was allowed clears the session grants and stops every running subagent; their stop reports name the reason, the last activity and the files each changed. In an interactive session `/permissions <mode>` and the editor's cycle shortcut first name the running subagents and ask; declining keeps the current mode. Without a UI the change applies at once. Widening never asks.

## Subagents and shared git state

A subagent that works in the shared working tree (started without `isolate: true`) is refused shell commands that change git state other agents share: `git add`, `git rm`, `git stash` (except `list`, `show` and `create`), `git commit`, `git reset`, `git restore`, and `git checkout -- <path>`, `git checkout <ref> -- <path>` or `git checkout .`. Dry runs (`-n`, `--dry-run`) are allowed. The refusal tells the agent to leave git state to its parent and report the files it changed. The check is an invariant in the `tool_call` pipeline ([`permission/git-state.ts`](../src/octocode/permission/git-state.ts)), before hooks and the permission mode, so `full` mode, a hook or a source allow cannot lift it; a command a hook rewrites is checked again.

The check reads the command's words past wrappers (`env`, `timeout`, `sudo`), `VAR=value`, command chains, `eval`, and the scripts of `bash -c`, a heredoc or `echo … | sh` ([`permission/shell/git-state.ts`](../src/octocode/permission/shell/git-state.ts)). Like the destructive-command check, it is a guard against mistakes rather than a security boundary: quoting and variable tricks can get past it. An isolated subagent works in its own worktree and keeps these commands; the main session is unaffected.

## MCP tools

Each MCP tool call uses the ordinary `mcp.write` class ([`gate/classify.ts`](../src/octocode/permission/gate/classify.ts), [`mode.ts`](../src/octocode/permission/mode.ts)). `manual` asks; `workspace` and the default `full` allow it. A session grant covers one tool name.

MCP annotations are unsupported and discarded. Server hints cannot waive an approval or mark output trusted. The [provenance check](../src/octocode/permission/provenance.ts) treats every MCP result as untrusted and every MCP call's arguments as consequential. Echoes of supplied arguments, such as a requested file path, do not become newly untrusted; earlier taint and checks on new server content remain. A provenance hit still asks in `manual` and `workspace`; `full` records it. Hook and source-policy checks remain in force.

### Hook-initiated MCP calls

A hook that calls an MCP tool (`mcp_tool`, see [hooks](hooks.md)) passes the same permission step as a model call: ordinary MCP classification, provenance, hook asks and the read-only role refusals. A refused call fails the hook with the reason. Two parts of the `tool_call` pipeline do not apply: PreToolUse hooks and extension `tool_call` handlers do not run for the hook's own call, because they would run the same hook again. The MCP owner also refuses a tool that is hidden by `toolExposure` or that its server no longer offers. In `manual` and `workspace` the user may be asked while the hook waits; the hook's timeout keeps running. Two cases are not gated, to avoid waiting on themselves: a `PermissionRequest` hook (it answers an ask, so it cannot ask) and a hook call made while another hook call is being decided (for example a `Notification` hook fired by that ask), which is refused. Hook configuration is trust-gated like a command hook. The implementation is [`hooks/mcp-gate.ts`](../src/octocode/hooks/mcp-gate.ts).

## Read-only roles

A subagent whose profile sets `readOnly: true` (the bundled `reviewer`, `researcher` and `browser`) runs with `OCTOCODE_SUBAGENT` and `OCTOCODE_READ_ONLY` in its environment. The permission gate refuses its changes in every mode, `full` included, before any dialog ([`permission/read-only-role.ts`](../src/octocode/permission/read-only-role.ts)):

- `file`, `edit` and `write` may change only the child's scratch folder, `.octocode/tmp/`, and Markdown documents under `.octocode/`, except in the folders and files later sessions load as configuration (`skills/`, `agents/`, `prompts/`, `themes/`, `extensions/`, `hooks.json`, `settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`; matched in any letter case). `graphBuild` is allowed: it writes only derived snapshots under `.octocode/graph/`.
- `bash` is refused when the shell parser ([`permission/shell/mutation.ts`](../src/octocode/permission/shell/mutation.ts)) shows a change inside the workspace outside those places, or cannot tell where a command writes. PowerShell is allowed only for commands the read-only list recognizes.

This is a policy, not a sandbox: a program that writes by itself (`node script.js`) is not seen. MCP tools are not restricted by it. For the roles themselves see [native features](native-features.md#configuration).

## Claude permission rules

Native sessions always apply the partial Claude permission-rule adapter. Rules apply independently of hook execution; `disableAllHooks` does not disable these restrictions, and child sessions inherit them. Hook-based approval uses [PermissionRequest hooks](hooks.md#permission-request-preview). A typed `!` command that no rule or shell-target check concerns still runs as typed consent.

The adapter reads the `permissions.deny`, `permissions.ask` and `permissions.allow` arrays from Claude user settings and project settings. User settings honor `CLAUDE_CONFIG_DIR`. Project deny and ask rules restrict calls before trust; project allow rules require native configuration trust. Files are inspected again at tool boundaries. The adapter does not write source settings or import another host's trust decisions.

Current source locations are:

| Scope         | Location                                                                | Activation                                                  |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| User          | `$CLAUDE_CONFIG_DIR/settings.json`, otherwise `~/.claude/settings.json` | Always parsed                                               |
| Project       | `<repository root>/.claude/settings.json`                               | Restrictions always apply; allow rules require native trust |
| Project local | `<repository root>/.claude/settings.local.json`                         | Same local adapter trust rule                               |

This reuses Octocode's repository-root discovery. Claude's working-directory, worktree and local-settings trust distinctions are not all reproduced. Unsupported `permissions` keys, including source mode and additional-directory settings, produce diagnostics and are not applied. Native mode remains in effect.

For example, this user configuration denies Bash calls and requires approval for web fetches:

```json
{
	"permissions": {
		"deny": ["Bash"],
		"ask": ["WebFetch"]
	}
}
```

Deny takes precedence over ask, then allow. Source asks still require resolution in native full mode and despite existing native grants. A supported source allow can resolve an ordinary native approval, but cannot bypass tool invariants or authorize unrelated private-network, upload or subagent permissions. An unresolved headless request is refused. A PermissionRequest hook can answer the original ask; outer Bash and staged file-query replacement are available in the [permission-hook preview](hooks.md#permission-request-preview), while persistent permission-update effects remain unfinished.

Tool-wide denies also affect model-visible and callable tools. Native tools can combine several source operations: a partial restriction on `file`, `bash`, `web` or `agent` must still be enforced on the specific operation without hiding unrelated operations. Removing a rule should restore the user's prior tool selection.

The preview is not full Claude policy compatibility. The active implementation and tests are tracked in the [compatibility matrix](../../../docs/PLUGINS_MODS_HOOKS.md#source-permission-policy-implementation-in-progress).

## Bash matching

The adapter uses a bounded syntax parser for command lists, pipelines, subshells, substitutions and redirects. It checks nested executable commands; quoted operators remain literal text. Separate rules can cover each command. Tested semicolon and `&&` lists also accept exact whole-command allowances; pipelines and subshells require coverage of their executable commands. Bare `Bash` and `Bash(*)` grants are equivalent.

Executable names can be statically unquoted. Argument spelling and redirect positions stay raw. The source-specific wrapper adapter has these tested boundaries:

| Form                                                                         | Current behavior                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob` | Tested forms inspect the inner command; option support is bounded                                              |
| `command -v` or `command -V`                                                 | Lookup stays matched as the outer command                                                                      |
| Bare `xargs`                                                                 | Inspects the inner command; flagged forms retain outer matching                                                |
| `NODE_ENV=value command`                                                     | Inner allow, deny and ask matching                                                                             |
| Other leading assignments                                                    | Inner deny/ask matching; no inner allowance                                                                    |
| `time -p command`                                                            | Inner deny/ask matching; no inner allowance                                                                    |
| `nice -n3`, spaced or long `stdbuf` options                                  | Retain outer matching                                                                                          |
| Exec wrappers and effectful `find`                                           | An outer wildcard allowance cannot bypass the detected execution hazard; supported exact rules remain separate |

Full wrapper-option and assignment support, control-flow/heredoc semantics and PowerShell parsing remain incomplete. Unsupported restricted syntax is refused with a diagnostic; this differs from upstream for some malformed or unsupported constructs.

## Shell file targets

With compatibility enabled, the permission owner checks recognized Bash redirects, `tee` destinations and operands of bare or supported wrapped `cat`, `head`, `tail` and `wc` before starting the process. Path-scoped `Edit` denies cover output targets; path-scoped `Read` denies cover input targets. These checks also apply when no Bash rule is configured. A denied later target prevents earlier commands in the same invocation from running.

The shell adapter deliberately keeps these rule categories separate:

| Rule                                           | Effect on recognized shell targets                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Path-scoped `Read` / `Edit` deny               | Blocks the corresponding read / write target, including resolved symlink targets                |
| Bare `Read` / `Edit`, or `Read(*)` / `Edit(*)` | Does not cross-apply to shell targets                                                           |
| Path-scoped file ask                           | Does not add a Bash approval request                                                            |
| Path-scoped file allow                         | Covers that target; does not authorize the shell command itself                                 |
| Broad `Bash` / `Bash(*)` allow                 | Covers tested ordinary targets, including outside the workspace; matching file denies still win |
| Scoped Bash allow                              | Still needs target approval or a matching file allowance                                        |

Protected project paths still require approval in manual/workspace modes, including when a file allowance matches. Known writes into Octocode's state folder are refused in every mode. These checks share one original Bash permission request, including for typed shell commands; they do not manufacture separate file-tool hook events. Compatibility-off typed-command behavior is unchanged.

File-descriptor duplication and `/dev/null` are excluded from file-target checks. Dynamic targets and unsupported syntax cannot be resolved completely by this parser. An applicable file deny with an unresolved target is refused; a broad Bash allowance can cover ordinary uncertainty when no restriction blocks it. Arbitrary scripts and indirect file access are not intercepted by these checks. Reader operand parsing covers tested options, quoted and multiple filenames, and `--`. Absolute executable paths such as `/bin/cat` are not normalized into recognized readers. Other commands and indirect reads remain outside this operand adapter.

Reader option handling separates source-rule candidates from actual file targets. For example, Claude applies `Read(./1)` to the detached count in `head -n 1 safe.txt`; that count can trigger a source deny but cannot grant access to `safe.txt` or create a native file-access request. `head +1` retains `+1` as a filename; the tested legacy `tail +1` count is source-deny-only.

On macOS, `head`, `tail` and `wc` open a literal `-` filename, while `cat -` reads standard input. The adapter retains the former as possible file targets and stops interpreting options after a file or stdin operand. This conservative handling can add review or denial for GNU forms that treat those tokens differently. Unknown options and dynamic filenames remain unresolved rather than silently losing possible targets. GNU-only `wc --files0-from` content reading is not implemented.

The pinned vendor replay exposes differences that remain explicit: interleaved redirects can hide reader operands or pipeline `tee` writes from upstream file-deny checks, while Octocode checks those targets. Bash `<>` read/write redirection is unsupported by the current parser and is refused under applicable file restrictions; the pinned upstream executable failed to enforce the tested read/write denials for that form. Directory changes and unsupported shell constructs can also produce conservative refusal or additional review. This is a developing policy adapter, not a filesystem sandbox. If parser assets are unavailable, applicable scoped restrictions refuse the invocation. Without those restrictions, manual/workspace modes require review of the unresolved targets; full mode can proceed. Protected-path checks require an identified target.

## Other compatibility limits

- File matching supports a subset of source path rules. Ordered negation, every source discovery/anchor case and every native read route need further coverage.
- Native agent profiles are not Claude's built-in subagent catalog; an omitted profile does not invent a Claude role name. Source `Read` rules match the actual Read/standalone read invocation. The default Octocode MCP `localFetch` and search tools retain MCP identities and are not automatically covered by Claude `Read` or `Grep` rules. Match their MCP names where needed; the semantic bridge remains unfinished.
- Claude permission modes, managed settings, additional directories, skill-scoped grants and persistent permission updates remain separate work.
- Codex Starlark execution rules and sandbox profiles are not implemented by this Claude adapter.

Keep source-specific settings separate. Consult [Claude permission rules](https://code.claude.com/docs/en/permissions) and [Codex execution rules](https://learn.chatgpt.com/docs/agent-configuration/rules) when porting policy, and validate actual allowed and denied effects against the target host before relying on a compatibility claim.

## Native planning

`/plan` adds an independent host constraint over the current permission mode, including `full`. `/permissions plan` enters it; `/permissions plan off` leaves it. This constraint uses explicit host-owned operations rather than trusting arbitrary MCP read-only annotations. It pauses executable hooks and blocks shell execution, mutation tools and delegation. Plan state follows the selected session branch. See [native planning](native-features.md#native-planning-constraint) for allowed operations, approval, transport support and the trusted-extension boundary.
