# Permissions

Octocode's permission owner decides whether an action needs approval. These checks are separate from operating-system sandboxing. Native modes do not change the process's filesystem or network privileges.

## Modes

**The default mode is `full`: no routine asks.** To limit the agent, set `OCTOCODE_PERMISSION` to `manual` or `workspace` before starting (an invalid value starts in `manual`), or change the mode in a session with `/permissions manual|workspace|full`. `/permissions` alone shows the state; `/permissions grants` lists session grants and `/permissions grants clear` removes them.

| Action class                                                                                                                                                                                                                                                                                           | `manual` | `workspace` | `full` |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- | ------ |
| Reads outside the workspace (`read.outside`), file changes in the repository (`file.workspace`), shell commands (`shell`), web requests (`web`), browser actions (`browser`), MCP tool calls (`mcp.write`), starting a subagent (`agent.spawn`)                                                        | asks     | allows      | allows |
| File changes outside the workspace (`file.outside`), destructive shell commands (`shell.destructive`), taking control of the browser (`browser.control`), private or local addresses (`net.private`), uploads from outside the workspace (`upload.outside`), destructive MCP tools (`mcp.destructive`) | asks     | asks        | allows |

The [mode table](../src/octocode/permission/mode.ts) is the source. It also lists the reasons that force an ask (hook asks, provenance, source rules). Reservations, protected state, file review and other tool invariants remain in their owning tools.

In `workspace` mode, inline interpreter code (`python -c`, `node -e`) and programs the shell parser does not know run without asking, like any other `shell` action; only the writes the parser can see are checked (see [Shell file targets](#shell-file-targets)). This is a settled decision: use `manual` to review every command. Workspace mode is therefore no defence against code an agent deliberately hides: inline interpreter code, arithmetic on a variable that holds a command (`x='a[$(cmd)]'; echo $((x))`), a computed option (`sort $X in`, with `X` set to `-o` and a path) and a program a git command line names (`git -c core.pager=… log`, `GIT_SSH_COMMAND=… git fetch`, `git fetch --upload-pack=…`, `git archive --exec=…`) run unasked there. The stricter boundaries are plan mode, which runs only lines that both the quick scan and the bash parse read as read-only and so refuses all four, and peer reservations, which refuse all four while another agent holds a reservation ([native features](native-features.md#file-mutation-guarantees)). Both read a computed word given to a reader with a writing option (`sort`, `rg`, `find`, `uniq`, `tree`, `file`, `date`, git readers) before `--` as a possible option unless it cannot become one: its value starts with a literal character and it has no unquoted `$` or backtick (`rg x src/*.ts`, `rg x ./"$F"`), it is a quoted value right after a value-taking option (`find . -name "$N"`, `git log --since "$D"`), or a long option with a literal name (`--since="$D"`) that does not write. The [read-only role](#read-only-roles) checks only the writes the parser finds, so it refuses none of the four.

Tool output reaches the model unredacted. To redact secrets from it, add a `tool_result` [hook](hooks.md).

### Project trust

`/trust project` decides whether Octocode loads this project's resources; the choice is saved and takes effect after a restart. `/trust config` approves the exact current content of the project's hook, MCP, agent and skill files (it asks again when any of them changes) and reloads; it needs the interactive terminal and project trust first, and `/trust off` revokes it. Plain `/trust` opens a menu of both. See [native features](memory.md#memory) for how trust affects memory injection.

A mode change that makes some action ask where it was allowed clears the session grants and stops every running subagent; their stop reports name the reason, the last activity and the files each changed. In an interactive session `/permissions <mode>` and the editor's cycle shortcut first name the running subagents and ask; declining keeps the current mode. Without a UI the change applies at once. Widening never asks.

## Subagents and shared git state

A subagent that works in the shared working tree (started without `isolate: true`) is refused shell commands that change git state other agents share: `git add`, `git rm`, `git stash` (except `list`, `show` and `create`), `git commit`, `git reset`, `git restore`, `git checkout -- <path>`, `git checkout <ref> -- <path>` or `git checkout .`, a `git switch` or `git checkout` that moves HEAD or rewrites files (a branch, start point or path operand, or `--orphan`; a new branch at HEAD such as `git switch -c x` is allowed), `git merge`, `git rebase`, `git pull`, `git cherry-pick`, `git revert`, `git am`, `git mv` and `git clean`. Dry runs (`-n`, `--dry-run`) of `add`, `rm`, `commit`, `mv`, `clean` and `pull` are allowed. The refusal tells the agent to leave git state to its parent and report the files it changed. The check is an invariant in the `tool_call` pipeline ([`permission/git-state.ts`](../src/octocode/permission/git-state.ts)), before hooks and the permission mode, so `full` mode, a hook or a source allow cannot lift it; a command a hook rewrites is checked again.

The check reads the command's words past wrappers (`env`, `timeout`, `sudo`), `VAR=value`, command chains, `eval`, and the scripts of `bash -c`, a heredoc or `echo … | sh` ([`permission/shell/git-state.ts`](../src/octocode/permission/shell/git-state.ts)). Like the destructive-command check, it is a guard against mistakes rather than a security boundary: quoting and variable tricks can get past it. An isolated subagent works in its own worktree and keeps these commands; the main session is unaffected.

## MCP tools

Each MCP tool call uses the ordinary `mcp.write` class ([`gate/classify.ts`](../src/octocode/permission/gate/classify.ts), [`mode.ts`](../src/octocode/permission/mode.ts)). `manual` asks; `workspace` and the default `full` allow it. A session grant covers one tool name.

MCP annotations are unsupported and discarded. Server hints cannot waive an approval or mark output trusted. The [provenance check](../src/octocode/permission/provenance.ts) treats every MCP result as untrusted and every MCP call's arguments as consequential, with one exception: Octocode's own local readers and searches, recognised by the host's tool names and never by server hints. Their text from workspace paths is trusted, text from any path outside the workspace counts as private (every path a query names counts: an `lspSearch` `workspaceRoot` outside the workspace makes the read private whatever its `path`) (a later web request or network command that repeats it is a hit), and a cursor page has the origin of the page that returned its cursor (a cursor the session did not see stays untrusted). A shell command that reads a file outside the workspace (`cat ~/.ssh/config`, `rg KEY /etc`, `cd /etc && cat x`; any literal outside path in the line counts) is private too, while network commands stay untrusted ([`provenance/shell-reads.ts`](../src/octocode/permission/provenance/shell-reads.ts)). Other MCP servers and Octocode's GitHub tools stay untrusted. Echoes of supplied arguments, such as a requested file path, do not become newly untrusted; earlier taint and checks on new server content remain. A provenance hit still asks in `manual` and `workspace`; `full` records it. Hook and source-policy checks remain in force.

### Hook-initiated MCP calls

A hook that calls an MCP tool (`mcp_tool`, see [hooks](hooks.md)) passes the same permission step as a model call: ordinary MCP classification, provenance, hook asks and the read-only role refusals. A refused call fails the hook with the reason. Two parts of the `tool_call` pipeline do not apply: PreToolUse hooks and extension `tool_call` handlers do not run for the hook's own call, because they would run the same hook again. The MCP owner also refuses a tool that is hidden by `toolExposure` or that its server no longer offers. In `manual` and `workspace` the user may be asked while the hook waits; the hook's timeout keeps running. Two cases are not gated, to avoid waiting on themselves: a `PermissionRequest` hook (it answers an ask, so it cannot ask) and a hook call made while another hook call is being decided (for example a `Notification` hook fired by that ask), which is refused. Hook configuration is trust-gated like a command hook. The implementation is [`hooks/mcp-gate.ts`](../src/octocode/hooks/mcp-gate.ts).

## Read-only roles

A subagent whose profile sets `readOnly: true` (the bundled `reviewer`, `researcher` and `browser`) runs with `OCTOCODE_SUBAGENT` and `OCTOCODE_READ_ONLY` in its environment. The permission gate refuses its changes in every mode, `full` included, before any dialog ([`permission/read-only-role.ts`](../src/octocode/permission/read-only-role.ts)):

- `file`, `edit` and `write` may change only the child's scratch folder, `.octocode/tmp/`, and Markdown documents under `.octocode/`, except in the folders and files later sessions load as configuration (`skills/`, `agents/`, `prompts/`, `themes/`, `extensions/`, `hooks.json`, `settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`; matched in any letter case).
- `bash` is refused when the shell parser ([`permission/shell/mutation.ts`](../src/octocode/permission/shell/mutation.ts)) shows a change inside the workspace outside those places, or cannot tell where a command writes. PowerShell is allowed only for commands the read-only list recognizes; a line with a backtick, a `<#…#>` block comment, a here-string (`@'`, `@"`) or `--%` is refused, because a bash reading gets those wrong.

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

This reuses Octocode's repository-root discovery. Claude's working-directory, worktree and local-settings trust distinctions are not all reproduced. `permissions` keys other than `deny`, `ask`, `allow`, `defaultMode` and `additionalDirectories` produce diagnostics and are not applied, as does a `defaultMode` other than `default` (or `manual`), `acceptEdits` and `dontAsk` ([`source-policy/rules.ts`](../src/octocode/permission/source-policy/rules.ts)). What allows (allow rules, `defaultMode: "acceptEdits"` and `additionalDirectories`) loads only from the user's settings, an untracked local file or a trusted project; restrictions load from any source ([`source-policy-loader.ts`](../src/octocode/permission/source-policy-loader.ts)). Native mode remains in effect.

Path rules (`Read(…)`, `Edit(…)`) match deny and ask patterns in any letter case and allow patterns only in the case they name, so `Edit(docs/**)` does not approve `DOCS/x.md`, which is another directory on a case-sensitive filesystem. A path is also compared in its on-disk spelling, so on a case-insensitive volume a deny rule still meets a file reached through a differently cased directory ([`source-policy/match.ts`](../src/octocode/permission/source-policy/match.ts)).

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

The preview is not full Claude policy compatibility. The active implementation and tests are tracked in the [compatibility matrix](../../../docs/PLUGINS_MODS_HOOKS_ROLLOUT.md#source-permission-policy-implementation-in-progress).

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

Independently of compatibility rules, every agent `bash` call is also checked against the writes the shell parser finds ([`permission/shell/write-targets.ts`](../src/octocode/permission/shell/write-targets.ts) from [`shell/mutation.ts`](../src/octocode/permission/shell/mutation.ts)): `cp`/`mv`/`ln`/`install`/`touch`/`mkdir`/`rm` operands, destinations named by options (`dd of=`, `curl -o`, `wget -O`/`-P`, `rsync`'s last operand, `tar -cf`/`tar -x -C`, `unzip -d`), `git -C` repositories and the file `git config` writes, `find -delete` roots and the commands `find -exec` runs, and the scripts of `sh -c`, `bash -c` and `eval`. A write outside the repository or to a run-later file asks as `file.outside` in manual and workspace. A write the parser cannot place (an expansion, a script piped into a shell, `xargs` operands, `npm -g`, a relative path or in-place change after a `cd` it cannot follow, such as `cd ..` or `cd sub`) asks as `shell.target`. `~`, `~/x`, `$HOME/x` and `${HOME}/x` resolve to the home directory before the state-folder check, so a write into Octocode's state folder is refused in `full` too. `builtin cd` and `command cd` are followed like `cd`; a directory change made through `source`, `eval` or `trap` is not. A command whose program name is computed (`$X a b`, `$(…) a b`, backticks, `"$X"`) asks in `workspace` mode and is refused for a read-only role, because the parser cannot tell which program runs; variables in arguments are unaffected. Interpreters (`node script.js`, `make`, package scripts) remain unseen. Quoting and comments are read as bash reads them: `$'…'` with its escapes (`rm $'\x2fetc'` names `/etc`), `$"…"` as a computed word (bash translates it through the locale's catalog), and a `#` comment where bash starts one, so a command hidden between two such words is still checked. A here-string after another redirection (`cat > f <<< hi`) is read as input.

The parser reads past wrappers such as `sudo`, `env`, `timeout`, `xargs`, `flock` and `npx` using each one's option grammar ([`shell/wrapper-options.ts`](../src/octocode/permission/shell/wrapper-options.ts)). After an option it does not know, it cannot tell whether the next word is the command, so it asks. It also reads package-manager runners (`npm exec`, `pnpm dlx`, `bun x`), output options of readers and tools (`--output`, `-o`, `patch -o`/`-d`), and `ln`, `link`, `mkfifo`, `mktemp` and `patch` targets ([`shell/program-forms.ts`](../src/octocode/permission/shell/program-forms.ts), [`shell/destinations.ts`](../src/octocode/permission/shell/destinations.ts)). A hard link counts as changing its source too, so linking a file from outside the workspace counts as a change outside it. Only `~`, `~/x` and the `$HOME` spellings resolve; `~user`, quoted `"~/x"` and brace words are left unresolved ([`file-access.ts`](../src/octocode/permission/file-access.ts)), so they ask as `shell.target`. A wrapper whose command cannot be read is treated as running an unknown program; while a peer holds a reservation, such a command is refused (for example `timeout $T make`), and so is a computed program name.

`xargs` and GNU `parallel` (read as a wrapper) run their command with words read at run time ([`shell/input-runners.ts`](../src/octocode/permission/shell/input-runners.ts)). A program those words could make write asks in `workspace` mode and is refused while a peer holds a reservation: a reader with a writing option or output operand (`xargs sort`, `find`, `uniq`), a writer judged by its words (`tee`, `sed`, `cp`, a shell), and `git`, except `git add`, `git ls-files`, `git check-ignore` and `git rm --cached … --`, which run as they would without the runner (input words land after the visible subcommand, never among git's own options). A program that comes from input (`xargs sudo`, `xargs -I{} {} a`, a bare `parallel`), a replace string in git's subcommand or global options, and `parallel`'s `--results`, `--joblog`, `--tmpdir`, `--wd`, `-S` or an unknown option ask too. A reader that writes nothing whatever its words (`xargs grep`, `wc`, `cat`) still runs, and a program the guard does not model (`xargs npx prettier --write`) is judged as it would be without the runner.

`sed` is read by its own grammar ([`shell/sed-script.ts`](../src/octocode/permission/shell/sed-script.ts)). `-i`, `--in-place` and macOS `-I EXT` edit in place, and BSD's empty suffix (`sed -i '' s/a/b/ f`) is not taken for a file. With or without `-i`, the files a script's `w`, `W` and `s///w` write are targets like redirections (`/dev/stdout` and `/dev/stderr` excepted): outside the workspace they ask, and on a reserved path they are refused. The `e` command or flag, an unknown command, a script the scanner cannot read, a `-f` script file and a script from an expansion (`sed "$S" f`) ask. Git's output options are read per subcommand and placed under `git -C` ([`shell/destinations.ts`](../src/octocode/permission/shell/destinations.ts)): `--output` (diff options), `format-patch -o`/`--output-directory` and `archive -o`/`--output` name their targets, and an abbreviated output option (`--output-dir`, `--out`) asks. `format-patch` without `-o`, `--output-directory`, `--output` or exactly `--stdout` writes its patches where it runs (under `git -C`'s repository): inside the workspace it runs unasked, from or into a directory outside it asks, and the read-only role refuses it (`--stdout` prints them instead). `git cat-file --filters` runs the configured filter programs and is treated like `--textconv`: plan mode refuses it, workspace mode asks and the read-only role refuses it. `git ls-files -o` (`--others`), `git grep -o` and `git diff -O <orderfile>` are read-only.

The file tools refuse to edit a file whose bytes are not valid UTF-8, since the edit would rewrite bytes they cannot decode; replace it whole with a write, or change it from `bash` with a tool that keeps its encoding ([`files/tool/guard.ts`](../src/octocode/files/tool/guard.ts)).

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
