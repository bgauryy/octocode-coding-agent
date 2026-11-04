# Agent self-audit: questions Octocode answers about itself

Questions the owner wants answered about Octocode, by Octocode itself. Each section's answer gets a verdict, evidence (`path:line`, a command or a transcript), and a "What could be better" list ranked by effect on a real user. An answer that is inferred says so.

Results are in [Answers](#answers). Add a question when a real session surprises someone.

## 1. Communication between agents

1. Do parent and child have a working two-way channel in the background and in the foreground? What can't get through in each?
2. Can a subagent always tell who its parent is and how to reach it? Exactly what does its prompt say, and is that enough for a model that hasn't seen the tool before?
3. Is the parent proactive? What in its instructions or the harness makes it answer, check on, redirect or stop a child, rather than wait for a report?
4. Does the parent ask the human a question when a decision is the human's? What pushes it to ask, and what pushes it to guess?
5. When a child asks its parent something, how does the parent learn of it, how fast, and what happens if the parent is busy, compacting or gone?
6. Can a child's question reach the human through its parent? Is any step lost or reworded?
7. Can siblings talk to each other, find each other and avoid each other's files? When is that useful, and do agents use it?
8. What happens to a message sent to a child that has finished, lingers, was resumed, or was killed?
9. Are reports the right size? What does the parent lose from a long report, and how does it get the rest?
10. Is any message duplicated, lost, or sent to the wrong agent after compaction or resume?
11. Where do agents poll or wait when an event would do?
12. Do the tool's descriptions, the policy and the docs agree about all of this?

## 2. How the coding agent thinks

1. What does the agent decide before its first tool call, and what is it told to decide?
2. Does it plan multi-part work, and when does a plan change? What makes it notice that a plan is wrong?
3. How does it choose between doing work itself and delegating? Is the rule followed in transcripts?
4. How does it choose a model and thinking level for a child? Why do parents override role routes?
5. How does it verify its work? What stops it from reporting success without evidence?
6. What makes it reorient after a compaction, a resume or a surprise?
7. When does it stop? What makes it stop too early or keep going too long?
8. How does it handle a wrong premise from the user or a failing test?
9. How does it treat a tool result as evidence rather than instruction?
10. Where does it waste thinking, such as re-deriving known facts or repeating failed calls?

## 3. Prompt engineering and instructions

1. Is each rule placed where the model reads it at the moment of decision?
2. Which rules conflict, duplicate each other or never apply?
3. Which rules does the model ignore in real transcripts, and why? Should a harness default replace them?
4. Does each rule have its condition beside its action, in plain language?
5. Is the cached prefix stable across turns, siblings and compaction? What breaks it?
6. Which parts of the system prompt earn their size? What could go with no effect on correctness?
7. Do a role's prompt, its skills and its model route fit its job?
8. Are the tool descriptions clear to a model on first read? Which fields get misused?
9. Do skill descriptions route correctly, and do agents load several when several apply?
10. Do the prompts ask the model to ask enough questions, of itself, its parent and the user?
11. How would we know a prompt change helped? What does the eval miss?

## 4. The code

1. Does each behavior have one owner? Where is the same behavior implemented twice?
2. Which modules are too large, too coupled or too hard to test?
3. Where do tests fake something that hides a real bug, as `owner: "native"` once did?
4. Which errors are swallowed, and which failures look like success?
5. Which features, settings or commands are dead or undocumented?
6. Are cancel, cleanup and process ownership correct on every path?
7. What are the riskiest files to change, and why?
8. What would a new contributor get wrong first?

## 5. Memory efficiency

1. What does an idle session hold in memory, and what grows with session length?
2. Are session entries, tool results, transcripts or MCP catalogs kept in memory more than once?
3. What is unbounded? Cover caches, maps, listeners, queues, and buffered output.
4. Does a long session, or one with many subagents, leak memory or file handles?
5. How much memory does each child process cost, and how many can run at once?
6. Which startup work could be lazy with no effect on behavior?
7. Is on-disk growth bounded: sessions, scratch folders, archives, worktrees, logs?
8. Agent memory, the feature: what gets saved and injected, is it relevant, and does it go stale?

## 6. Rendering

1. How does the terminal UI draw a frame, and what triggers a redraw?
2. Does a long session or heavy streaming slow rendering? What is the cost per frame, and what is cached?
3. Do wide tables, long lines, wide characters, images and resizes render correctly?
4. How does the view shorten text while keeping the source whole?
5. Is output readable with no color, in small terminals and on Windows?
6. How does the web view render, what does it hold in memory, and what happens with a huge session?
7. Do terminal and web view show the same facts about a session?
8. Which rendering work runs when nothing has changed?

## 7. CPU and GPU

1. What uses CPU while the agent is idle? Cover timers, polling, spinners and watchers.
2. What is the CPU cost of startup, of a tool call, and of streaming?
3. Which work blocks the event loop, and where does sync file or process work sit on a hot path?
4. How many processes run per session and per child, and do they share a server such as Octocode MCP?
5. How does parallel work limit itself, and what happens under heavy machine load?
6. Does anything use the GPU? Cover the terminal, the web view, local models and Chrome.
7. For local models: how is a model picked for the machine's memory and GPU, and what stops one from freezing the machine?
8. What does a user do when a machine is too slow? Is there a setting, and do the docs say so?

## 8. Commands

1. For every slash command, shell command and mode: what is it for, and what is its flow from input to effect?
2. Does each one say what happened, what failed and what to do next?
3. Does each one behave the same in the terminal, print, RPC and ACP, or say why not?
4. Which commands overlap, are hard to find or could go?
5. Do `--help`, `/help` and the docs list the same commands with the same meaning?
6. Which commands can lose work, and do they confirm first?
7. What can't a user do from a command that they need to, such as seeing what a child is doing or answering its question?

## Answers

Checked 2026-11-04 against the working tree. Octocode answered from the frozen ref `refs/octocode/self-audit-2026-11-04` (run `.octocode/self-audit/run-20261104T115128`). Line numbers will drift: `team/`, `subagents/` and `instructions/policy/` are being edited.

Paths: `oc/` is `packages/coding-agent/src/octocode/`, `ca/` is `packages/coding-agent/src/`, `tui/` is `packages/tui/src/`. Labels: **read** (I read the lines), **ran** (I ran it, or a transcript records it), **inferred**, **claimed** (Octocode's answer, not rechecked). Every item under "What could be better" is confirmed by reading the deciding lines; each ends with the smallest fix.

Of the claims checked, 15 were refuted (3 of them in part), 5 were already fixed, 3 proposals were dropped under the owner's rules, and 8 were dropped as unverified or not worth their cost. Each section says which.

### 1. Communication between agents

**Verdict:** the channel works in both directions and a small model found it from its prompt alone. Delivery of what comes back is the weak part: reports arrive one per parent turn, and one can be out of date by the time it is read.

**Live test (ran; `s1` transcripts).**

| Time | What happened |
|---|---|
| 12:10:08 | Parent starts `jolly-tentacle` (researcher, `small:low`, background). |
| 12:10:13 | Child calls `agent` `type:"message"`, `to:"parent"`, `replyRequired:true`, without being told how in its task. Result: "Queued message #1 … must answer with replyTo 1". |
| 12:10:14 | Message is handed to the parent, with "(reply: agent type message, input.to jolly-tentacle, input.replyTo 1)". |
| 12:10:17 | Child ends its turn: "I have no way to poll for it". The status becomes a report with no outcome word ("finished"). |
| 12:10:23 | Parent replies with `replyTo:1`. Result: "Resumed jolly-tentacle with your message". |
| 12:10:24-29 | Child receives #2, reads the file, writes `done:` with a correct fact. |
| 12:10:47 | Parent ends its turn because the notices said "The full report follows when this turn ends". |
| After that | It receives the first report only. That report still says "1 ask (1 unanswered)" and "is waiting for your reply", both false by then. |
| 12:11:35 | Parent writes its final answer and reports the `done` report as lost. |
| After that | The `done` report arrives. Parent at 12:11:54: "I was wrong earlier". |

The child's reachability is confirmed. Its remark that "nothing gave the exact `to` value" is wrong: `oc/instructions/shared/ask-parent.md:1` and the tool schema ("Agent id, role or \"parent\"") both state it.

1. **Two-way channel.** Background: yes (ran). Foreground: the parent reads messages only with the report, so a decision goes in a `blocked` report (`oc/instructions/subagent/identity.md:2`, read). New since the run: `oc/instructions/notices/mail/parent-waits.md:1` tells the child so when it messages.
2. **Who and how.** Prompt says "You work for `<id>`" and "a message to `parent` that needs an answer". Enough for Haiku (ran).
3. **Proactive parent.** Policy says to answer, check on, redirect and stop (`oc/instructions/policy/delegation.md:22-25`, read); the harness wakes it with the `replyTo` (ran). New since the run: a 5-minute check-in inside the child that costs the parent nothing (`oc/team/check-in.ts:29-67`, read).
4. **Asking the human.** `delegation.md:24`, `policy/work.md:6` (read). No evidence on behavior: every trial forbade questions.
5. **Learning of a question.** Team database checked each second and after a step that ran tools (`packages/coding-agent/docs/native-features.md:268`, read). Live: handed over in 1 s, answered 10 s after it was sent (ran). Parent gone: the child ends itself (`oc/team/session/parent.ts:45-52`, read). During a compaction: not checked.
6. **Child to human.** The child can't ask the user; the parent retypes into `askUser`, which has no `forward` (`oc/ask/tool.ts`, read), so rewording is possible. The user can also answer directly (section 8, Q7).
7. **Siblings.** `oc/instructions/subagent/team.md:1-8` lists them and `paths` reserves files (read). Use: `s8`'s three researchers sent each other no messages, on disjoint work (ran). Lean case only.
8. **Finished, lingering, resumed, killed.** A parent's or user's message resumes a lingering run; otherwise the sender gets "has finished" (`oc/subagents/linger.ts:236-241`, `oc/team/session/send.ts:205-234`, read). A run with an open ask lingers at least 600 s (`oc/subagents/claim.ts:52,66`, read).
9. **Report size.** Over 8 KB or 200 lines the parent gets the head, a trim note and the file path (`oc/instructions/report.ts:3`, `oc/subagents/report.ts:22,163-168`, read). `s8`: an 8.8 KB report lost 6 lines holding its ranked fixes, and the parent read them from the file (ran). This fits the no-truncation rule because a whole copy is named.
10. **Duplicates and loss.** Reports are acknowledged by session receipts (`oc/subagents/handoff.ts:136-158`, read). No loss or duplicate live (ran). After compaction or resume: not run.
11. **Polling.** Team ticker, report receipts and parent watch share one unref'd 1 s clock, running only while needed (`oc/shared/clock.ts:25-35`, `oc/team/ticker.ts:68-76`, read); late-report polling stops after a short window (`oc/subagents/late.ts:34-38`, read). Cost: not measured.
12. **Do they agree?** Tool schema, policy and `native-features.md:382` agree on `to:"parent"` (read). The gap is what a child should do after asking (below).

**What could be better**
1. **Done 2026-11-04.** **Deliver waiting reports together.** Reports are follow-ups (`oc/subagents/handoff.ts:228`) and the default is one per drain (`ca/core/settings-defaults.ts:12`, `packages/agent/src/agent-loop.ts:341`). `s8`: "All three researchers have finished", then three separate turn ends to collect three reports. `s1`: a wrong final answer. Fix: drain consecutive report messages as one, leaving the user's own queue as it is.
2. **Done 2026-11-04.** **Don't hand over a report its own resume has made false.** The footer is built when the run ends (`oc/subagents/run-execution.ts:101,108-117`), and a resume does not touch it (`oc/subagents/linger.ts:283-292`). Fix: when a resume starts, mark that run's unread report as superseded, or hold it for the new run's report.
3. **Left: `instructions/shared/` is being edited by the coordinator; wording in the handoff.** **Say what happens after asking.** `ask-parent.md:1` says to finish with `blocked` but not that the answer resumes the conversation, so the child ended with a status and no outcome word. Fix: one clause in that line.
4. **Done 2026-11-04.** **Let a child's question reach the user unchanged.** Fix: a `forward` field on `askUser` that takes the stored message number.

**Refuted:** "say `to:\"parent\"` explicitly" (it is said twice). **Dropped, unverified:** replacing 1 s polling with events. Mail crosses processes through SQLite, the clock is shared and unref'd, and nothing measures a cost.

### 2. How the coding agent thinks

**Verdict:** nearly all of it is prompt text. The harness enforces only the loop guard, request budgets, fences, stale receipts and resume notes, so whether agents follow the rest needs the eval.

1. **Before the first call.** What done means, which check proves it (`oc/instructions/shared/think-check.md:1`, claimed); question or edit, and ask if an unknown changes scope (`policy/work.md:2,6`, read).
2. **Plans.** Dependency graph (`policy/delegation.md:5`, read). The only harness signal for a wrong plan is the loop guard (read). Otherwise prompt only (inferred).
3. **Self or delegate.** `delegation.md:4` (read). In the 8 trials, only the two told to delegate did, and `s8`'s parent verified deciding anchors itself (ran). Too small a sample to say more.
4. **Model for a child.** Explicit `model` beats the profile route (`oc/subagents/claim.ts:226-229`, claimed). `s8` kept the route; `s1` set `small:low` for a test (ran). "Why parents override": no evidence beyond the field text inviting it.
5. **Verifying.** `policy/work.md:20` asks for it; `bash verify:true` makes a receipt that goes stale on edit (`oc/files/bash/verification.ts:99,120-136`, read), read only by bash results (`oc/files/bash.ts:245-259`, read). Nothing stops an unverified "done".
6. **Reorienting.** `oc/instructions/shared/reorient.md:1` (read), `[Resumed]` brief (claimed). A surprise is prompt only.
7. **Stopping.** Identical outcomes: notes at 3 and 5, refused and run ended at 8 (`oc/loop-guard.ts:24-29`, read). Child budget: 160 requests soft, 240 hard, from 154 measured runs (`oc/subagents/budget.ts:19-29`, read). Early stops: `s1`'s child stopped early because it had no way to wait (ran).
8. **Wrong premise, failing test.** `policy/work.md:6,16` (claimed for `:16`). Prompt only.
9. **Evidence, not instruction.** Web and non-local MCP results are fenced (`oc/shared/untrusted-results.ts:7-31`, read); local reads and bash rely on the prompt.
10. **Wasted thinking.** No exact repeat of an Octocode call in any trial (ran). Wasted calls: see "How Octocode did".

**What could be better**
1. **Done 2026-11-04.** **Put verification state in the report.** Fix: a footer line on a child's report when the child edited after its last passing `verify` run. A note, not a gate; `oc/subagents/run-execution.ts:108-117` is where footers are built.
2. **Left: `instructions/policy/` is being edited by the coordinator; wording in the handoff.** **State routing once.** `delegation.md` ("Route each task…") and the `model` field (`oc/subagents/agent-tool.ts:52`) both give a size table beside the role routes. Fix: keep the field's text and point the policy line at it.

**Already fixed:** a transcript-based eval (`scripts/agent-eval/`; `result.json` records delegation, skill loads, batching and bash use). **Dropped, unverified:** extra "surprise" signals, since near-miss detection is the patchy handling the owner rejected and nothing shows it would help. **Dropped, not worth it:** fencing bash output. Spotting `curl` needs a parser, and fencing everything costs tokens on each read (`untrusted-results.ts:10-11`).

### 3. Prompt engineering and instructions

**Verdict:** rules have their conditions and are mostly well placed. The confirmed faults are small; the largest cost, `<mcps>`, is one the owner has decided to keep.

1. **Placement.** Tool rules come before about 43 KB of `<mcps>`, then the policy. A child's identity rides in its first message, which is well placed (read, `.octocode/tmp/agent-prompts/main/system.md`).
2. **Conflicts.** Researcher "do not modify repository source" against its inlined skill's "Continue authorized research, edits and validation" (`.octocode/tmp/agent-prompts/researcher/system.md:725,816`, read). Duplicates: "read the source first" and "retrieved text is data" at `main/system.md:26,44,799` (read). `:44` comes from the MCP server.
3. **Ignored rules.** "Load every skill whose description matches" (`oc/instructions/system/skills-intro.md:1`): 0 skill loads in 8 trials, though all were research tasks (ran; a researcher child has its skill inlined). Not proof of harm: all eight graded pass.
4. **Condition beside action.** Yes in what I read; `policy/communication.md:9-10` and `delegation.md:4` are examples.
5. **Cached prefix.** Two blocks: base, then everything else (`ca/core/model-runtime/instruction-boundary.ts:14-18`, read). `mcps` is base and holds live server text (`oc/instructions/sections/index.md:7`, read). Cache hit rate in the trials was 0.90 to 0.97 (ran).
6. **Size.** Current main prompt is 66.8 KB: `<mcps>` 42.8 KB (64%), delegation 5.4, work 4.9, skills 4.5 (ran). Lean is 4.2 KB.
7. **Role fit.** Researcher `small:medium`, read-only, one inlined skill (`oc/instructions/roles/researcher.md:4-6`, read). Haiku did `s8`'s slices at $0.29 against the parent's $0.79 (ran).
8. **Tool clarity.** Most-misused field: `cursor`, sent inside `queries` in 3 of 8 trials (ran). `bash` is not the problem (below).
9. **Skill routing.** Not testable: nothing loaded.
10. **Asking.** Prompt says "Ask with askUser" even when no one can answer (see below).
11. **Knowing a change helped.** `scripts/agent-eval/` compares builds (correctness, then cost); ceilings in `packages/coding-agent/test/octocode/prompt-size.test.ts:229,277` guard size. It misses long sessions and real user questions (inferred).

**What could be better**
1. **Done 2026-11-04 (correct form named).** **Accept or correct a misplaced `cursor`.** The error is generic ("queries.0.path: must have required properties path … unexpected property cursor", `packages/ai/src/utils/validation-errors.ts:126-130`), and `s7` gave up paging. Fix: name the correct form in that message, or accept `{queries:[{cursor}]}`.
2. **Done 2026-11-04.** **Stop telling a headless agent to use `askUser`.** `canAsk` looks only at the tool list (`oc/turn.ts:75`, `oc/instructions/policy.ts:66`), while the tool answers "unavailable" with no UI (`oc/ask/tool.ts:150-151`). Fix: include `ctx.hasUI` in `canAsk`. No flag needed.
3. **Left: the line is in the sibling repository.** **Remove the edit language from read-only roles.** The line comes from the `octocode-research` skill in the sibling repository. Fix: reword there. Impact is limited, because `oc/permission/read-only-role.ts` refuses edits anyway.
4. **Left: needs the eval. The fourth Anthropic breakpoint is the history lookback's slot, so a third system block costs that.** **Give volatile sections their own cache block.** Date rollover or an MCP status change re-bills policy and skills too (`instruction-boundary.ts:14-18`). Fix: a third boundary before `environment`.
5. **Left: `instructions/policy/` and `shared/` are being edited by the coordinator.** **Remove the duplicates we own** at `main/system.md:26,799`. Fix: keep one.
6. **Done 2026-11-04.** **Fix the stale path** at `oc/instructions/README.md:39` (`octocode/tool-loadout.ts` is really `ca/core/agent-session/tool-loadout.ts`).

**Refuted:** "`bash` makes five fields required"; the schema requires only `command` and `reason`, at the frozen ref too (ran). "The docs pointer never applies"; it says "not the working directory" on purpose, and the trial ran from a copy (`oc/instructions/system/docs.md:1`, read). **Already fixed:** the eval and `AGENTS.md`'s link to it, and the `.octa/` scratch path (no such string left in `ca/`). **Dropped under the owner's rules:** cutting or lazily loading `<mcps>` (no lazy loading; contracts stay full); a headless env flag (no enablement flags; item 2 replaces it); gating skill loads on cost (several may load).

### 4. The code

**Verdict:** one real behavior bug, in code nothing in the repository calls. The rest is duplication and test looseness at a modest level.

1. **One owner.** The close-then-start queue is copied in `oc/shared/web.ts:15` and `oc/web-daemon/attach-register.ts:23` (read). Two per-provider credential queues differ slightly (`packages/ai/src/auth/credential-store.ts:15`, `ca/core/model-runtime/credential-operations.ts:39`, read).
2. **Size.** 8 source files at exactly 400 lines and 20 at 396-399 (ran). `oc/index.ts` has 81 imports (ran). That this is cramming: inferred.
3. **Fakes.** `packages/coding-agent/test/octocode/fake-host.ts:100` casts `as unknown as ExtensionAPI`, used by 281 test files (ran). `bash-policy-initialization.test.ts:6-14` stubs the parser, but other tests use the real one.
4. **Swallowed errors.** `execCommand` below; `ca/utils/ignore.ts:52`; model-catalog refresh at `ca/main.ts:329` and `ca/modes/interactive/interactive-mode/startup.ts:282` (read; the old catalog stays, so harmless).
5. **Undocumented.** `OCTOCODE_STARTUP_BENCHMARK`, `OCTOCODE_MANAGED_INSTALL_ROOT` and `OCTOCODE_INSTALLER_API_BASE` appear in no Markdown (ran), and an error message tells users to set the last (`ca/package-manager-cli/managed-install.ts:166`, read).
6. **Cancel and cleanup.** Only `execCommand` was found wrong; broader coverage: claimed by Octocode, not rechecked.
7. **Riskiest files.** `oc/permission/bash-syntax.ts`, `permission/ask.ts`, `oc/index.ts` (claimed, inferred from size and role).
8. **New contributor.** Two workspace import styles: 554 relative, 1,011 by name, in `ca/` (ran).

**What could be better**
1. **Done 2026-11-04.** **Fix `execCommand` (`ca/core/exec.ts`).** Ran the real module: a child that SIGKILLs itself returns `code:0, killed:false`; a child ignoring TERM with a 200 ms timeout ran its full 8 s, because `!proc.killed` (`:61`) is already false after SIGTERM; a spawn failure returns `code:1` with empty stderr. Effect is limited: the only caller is the public `api.exec` (`ca/core/features/api.ts:231`), with no in-repository use. Fix: track real exit for the SIGKILL, map a signal exit to non-zero, keep the spawn error text. No test covers it.
2. **Done 2026-11-04 (deleted in the working tree).** **Remove the committed `.codex/hooks.json`.** It holds `echo same`, a test value, and is tracked in git. It failed on every main-agent tool call in all 8 trials (186 entries; ran). Fix: delete it.
3. **Done 2026-11-04 (method names).** **Type `fakeHost`** so it can't drift from `ExtensionAPI` (`fake-host.ts:100`). Fix: `satisfies` on the parts it implements.
4. **Done 2026-11-04.** **Document the three variables** in `packages/coding-agent/docs/environment-variables.md`.
5. **Done 2026-11-04 (skill loading reports it; package discovery has no diagnostics to report through).** **Warn on an unreadable ignore file** (`ignore.ts:52`): today, ignored files are searched without notice.
6. **Done 2026-11-04.** **Merge small copies:** the close-then-start queue, and `errorMessage` in `ca/modes/interactive/bug-report.ts:295`, which reports "Unknown error" where the shared one keeps the text.
7. **Partly done 2026-11-04 (`handoff.ts`); the rest when next edited.** **Split files at the limit** when next edited; settle on one import style. Low effect.

**Refuted:** `attach-register.ts:57` is a deliberate fail-open with a stated fallback (`:56`). `ca/core/auth-storage/backends.ts:224` is not a per-key queue. "Add a real-parser test": `source-bash-wrappers.test.ts` and `permission-gate.test.ts` don't mock it (ran). Of the `errorMessage` copies, `packages/tui` takes no application dependency and `oc/llama/client.ts:45` does a different job, so they aren't duplicates to merge.

### 5. Memory efficiency

**Verdict:** real numbers exist in `process_samples`; Octocode didn't read them and guessed low. No leak was found, but nothing here tests for one over a long session.

**Measured (ran; read-only query of this machine's 391 samples from today, mostly short sessions).**

| Process | First sample RSS | Average | Peak |
|---|---|---|---|
| main | 299 MB | 283 MB | 554 MB |
| researcher | 259 MB | 216 MB | 365 MB |
| general | 304 MB | 190 MB | 310 MB |
| implementer | 234 MB | 147 MB | 300 MB |
| Octocode MCP pair, per agent (node + native; `ps` and samples) | | 70-90 MB | |

1. **Idle and growth.** Starts near 300 MB, not Octocode's "80-150 MB" (refuted). Every entry stays in memory after compaction (`ca/core/session-manager/state.ts:29-30`, read). Growth per session length: not profiled.
2. **Held twice.** On disk, yes: `session_entries` in `workspaces.db` is 158 MB beside a 235 MB sessions folder on this machine (`ca/core/session-manager/mirror.ts:95-111`; ran).
3. **Unbounded.** The entry list. Others are small (`labelTokenCache`, `overlapWarned`; read).
4. **Leaks.** None found in what was read (claimed); not tested.
5. **Per child.** About 250 MB plus 70-90 MB of MCP. Six at once (`oc/subagents/claim.ts:32`, read): about 2 GB (inferred from the table).
6. **Lazy startup.** One bundle, deliberately (`scripts/build-coding-agent.mjs:118`, `AGENTS.md`). Launchers enable the compile cache. Savings from splitting: not measured.
7. **Disk.** Output and scratch 30 days, transcripts 90 (`ca/config/retention.ts:14`, read). `~/.octocode/chrome-debug` is 823 MB across 14 entries, and nothing in `ca/` or `packages/mcp/src` mentions it (ran); the sibling package was not checked.
8. **Agent memory.** Budgets of 1,200 and 2,400 characters, 600 per line with a pointer to the whole (`oc/memory/inject.ts:12-25`, read). Staleness is displayed, and `/memory review` lists it (`oc/memory/store.ts:148-150,325`, read). Nothing expires.

**What could be better**
1. **Left: design and blockers in the handoff.** **Share the Octocode MCP server across a session's children.** 70-90 MB per agent, spawned afresh (`packages/coding-agent/docs/native-features.md:197`). Fix: a per-session shared server; larger than the other fixes. This also helps CPU.
2. **Left, owner's decision: the mirror recovers lost transcripts (`storage.ts:341`) and backs fork archives (`transcripts.ts:66`).** **Keep transcripts in one store, or prune the mirror sooner.** Fix: drop mirror rows for sessions not opened recently.
3. **Left, owner's decision: nothing in this repository or the sibling's source writes it, and its profiles (last used in September) can hold logins.** **Sweep or bound `chrome-debug`** under the same retention, if the sibling doesn't.
4. **Left: says to profile first; not profiled.** **Release entries before the last compaction** and re-read on demand (`state.ts:29-30`). The agent's view stays whole. Profile first.
5. **Done 2026-11-04.** **Rank unused memories lower** after a time (`store.ts:325`).

**Already fixed:** "publish measured numbers"; `/processes` and `process_samples` already have them. **Dropped, unverified:** code splitting (saving unmeasured, and the one-file bundle is a stated design). **Dropped, no effect:** capping the two small caches.

### 6. Rendering

**Verdict:** the default fullscreen mode is cheap even at 100k lines. Octocode's headline finding measured the wrong mode and the wrong step.

**Frame cost (ran; real `packages/tui` modules, Node 26, synthetic children returning cached lines).**

| Lines | Fullscreen layout | Regular: render + reset + clip | Regular: diff |
|---|---|---|---|
| 1,000 | 0.12 ms | 1.2 ms | 0.05 ms |
| 10,000 | 0.41 ms | 6.5 ms | 0.13 ms |
| 100,000 | 0.90 ms | 76 ms | 1.24 ms |

1. **A frame.** Requests merge to one per 16 ms; keys paint at once (`tui/tui/render-scheduler.ts:20`, claimed). Default `tuiMode` is `fullscreen` (`ca/core/settings-defaults.ts:86`, read), which writes only changed screen rows (`tui/tui-alt-screen/frame.ts:82-85`, read).
2. **Long sessions.** See table. Uncached components would cost more (inferred).
3. **Wide content.** Lines clip by column; images are left alone (`tui/tui/clip.ts:9-13`, read). Table fallback, graphemes: claimed.
4. **Shortening.** Source stays whole, previews cut in the view (claimed; matches the no-truncation rule).
5. **No color, small, Windows.** `NO_COLOR` and `TERM=dumb` (claimed). Windows tests exist (`packages/tui/test/native-platform.test.ts:29-31`, read). Very small terminals: not checked.
6. **Web view.** Pages of 50; `limit` grows with each request and has no ceiling (`packages/webview/src/app/live/history-window.ts:23-27`, read).
7. **Same facts.** Mostly the same event stream (claimed).
8. **Work when nothing changed.** A spinner tick still rebuilds the tree: 0.9 ms at 100k in fullscreen (ran).

**What could be better**
1. **Done 2026-11-04 (100k lines: about 10 ms, was 76 ms).** **Make regular mode's frame cost follow the changed lines.** `applyLineResets` and `clipLinesToWidth` touch every line, each frame (`tui/tui-main-screen.ts:108`, `tui/tui/clip.ts:9-13`). This is the 76 ms. Fix: cache per input line.
2. **Left: leaving out `3J` duplicates the whole transcript in scrollback on each resize event; `main-screen-clip.test.ts` pins that. Needs a viewport-only redraw.** **Keep the shell's scrollback on resize in regular mode.** A width change sends `\x1b[3J` (`tui/tui-main-screen.ts:117,151-154`). The transcript is redrawn, but what came before the session is gone, and regular mode exists for native scrollback. Fix: leave out `3J`.
3. **Left, owner's decision between the two.** **Enable or remove render pacing.** All off (`tui/tui/render-pacing.ts:26-29`); only `tui.ts` and a test use `setRenderPacing` (ran).
4. **Left: a cap would stop the user scrolling back, which is worse than the user-driven growth.** **Cap the web history** or drop far pages (`history-window.ts:25`). User-driven, so low.
5. **Done 2026-11-04.** **Make the delta cut visible** (`ca/core/application/transcript-stream.ts:102`). Only a single chunk over 64,000 characters reaches it, and that is rare (inferred).

**Refuted:** "the comparison already exceeds a frame at 100k lines" (it takes 1.24 ms, and Octocode's timings came from a copy of the loop); "no evidence of Windows tests". **Dropped:** "skip the full render when nothing changed" (0.9 ms in the default mode; item 1 covers regular).

### 7. CPU and GPU

**Verdict:** idle is quiet and nothing here uses the GPU directly. Nothing adapts to machine load, and CPU cost has never been measured.

1. **Idle.** Shared clocks stop when unused (`oc/shared/clock.ts:25-35`, read). A joined agent ticks each second (`oc/team/ticker.ts:68-76`, read). Reftable repositories poll every 250 ms (`ca/core/footer-data-provider.ts:382`, read); a `HEAD` polling fallback runs every 1 s (`:339`, read; on WSL, claimed).
2. **Cost.** Unknown. `OCTOCODE_TIMING` records wall time only (`ca/core/timings.ts:6`), and `process.cpuUsage` appears nowhere in `ca/` (ran).
3. **Blocking.** Each session entry: `statSync`, flushed `appendFileSync` and a SQLite mirror write (`ca/core/session-manager/persistence.ts:220-240`, read). That is per entry, not per token. Cost: not profiled.
4. **Processes.** A normal session has main plus up to 6 children, each with its own node and native MCP pair (ran, `ps`): about 21 processes, plus Chrome for a browser child. Octocode's "43 agents, 86 processes" is refuted: a child's `agent` tool offers only `coordinate` and `message` (`s1` child schema), and depth 2 needs a shell-started `octocode` (`oc/subagents/process/child-env.ts:70-76`, read).
5. **Limits.** Fixed: 6 subagents (`oc/subagents/claim.ts:32-38`, read); parallel tools uncapped (`packages/agent/src/agent-loop/tool-batch.ts:211`, read). No `loadavg`, `cpus`, `availableParallelism` or `freemem` in `packages/*/src` (ran).
6. **GPU.** None in the code; Chrome decides for itself (claimed). Chrome's own GPU cache is in `chrome-debug` (ran).
7. **Local models.** Sorted Q4_K_M first, user picks (`oc/llama/huggingface.ts:143-150`, claimed). No memory check anywhere (ran, as Q5's search).
8. **Slow machine.** Settings exist (`terminal.reduceMotion`, `OCTOCODE_MAX_SUBAGENTS`), but no docs page mentions a slow machine (ran).

**What could be better**
1. **Done 2026-11-04 (at download; a downloaded model's size is not in the catalog).** **Warn before a local model that won't fit.** Fix: compare the file size with free memory when choosing (`oc/llama/index.ts:176-188`), warn, and let the user go on. A past run froze this machine.
2. **Done 2026-11-04.** **Lower the default slot count on small machines.** Fix: derive `DEFAULT_MAX_SUBAGENTS` from `os.availableParallelism()` and total memory (`claim.ts:32`); the setting still wins.
3. **Left: see section 5.** **Share the MCP server** (section 5, item 1).
4. **Done 2026-11-04 (`how-to.md`).** **Add a "slow machine" section** to the docs, gathering what exists.
5. **Done 2026-11-04.** **Record CPU in `OCTOCODE_TIMING`.** Fix: `process.cpuUsage()` per phase, so the questions above can be answered.
6. **Partly done 2026-11-04: now 1 s, as the `HEAD` fallback. Nothing shows the watcher alone is enough.** **Drop the 250 ms reftable poll** if the watcher it duplicates is enough (`footer-data-provider.ts:364-382`). Reftable repositories only.

**Dropped, unverified:** "the watchdog kills slow children on a busy machine": the limit is 10 minutes of silence (`oc/subagents/process/outcome.ts:22`) and no transcript shows it; asynchronous session writes, until profiled.

### 8. Commands

**Verdict:** routing is consistent and refusals explain themselves. Several of Octocode's top findings fail on a read: `/purge` is documented, `/new`'s guard has no gap users can reach, and a user can already answer a child.

Octocode's table of 52 commands is not copied here: `.octocode/self-audit/run-20261104T115128/trials/s8-commands-r1/answer.txt` has it, with its flows, and I rechecked only the rows below.

1. **Flow.** Terminal: `ca/modes/interactive/interactive-mode/command-dispatch.ts`. Print, RPC, ACP: `ca/core/agent-session/prompt-expansion.ts:46-53` runs native commands and refuses built-ins with a reason (read).
2. **Says what happened.** Mostly. Silent, all in that same folder: `/new` cancel (`session-commands.ts:333`), `/clone` cancel (`session-navigation.ts:126-128`), declining `/quit` (`command-dispatch.ts:234`). `/jobs kill` and `/agents kill` print only "Stopping…" (read).
3. **Same in every mode.** Refusals say why (read). ACP's server never advertises commands; `available_commands` appears only where the client ignores it (`packages/acp/src/client/client.ts:287`; ran).
4. **Overlap.** `/clear` and `/reset` are the owner's request. `/web` and `/backlog` (claimed). No removal proposed.
5. **Help and docs.** `--help` never mentions `/help` (`ca/cli/args/help.ts`; ran). `commands.md:96` leaves out `/agents history`, which `oc/subagents/command.ts:25` has. Hints such as `/resume <search>` and `/new <name>` show optional arguments as required (`ca/core/slash-commands.ts:126,140`, against `commands.md:5`).
6. **Losing work.** Confirm: `/rewind` with a UI, `/purge`, `/processes stop`, and `/new`, `/resume`, `/fork` over running work (`oc/index.ts:153-171`, read). Don't confirm: `/quit` with idle parent, `/agents kill`, `/jobs kill`, `/permissions grants clear`, `/remote stop`, headless `/rewind` (read).
7. **What a user can't do.** Seeing a child works (`oc/team/routing.ts:229-245`, read). Answering works too: `/agents tell` reaches a running child and resumes a lingering one (`oc/subagents/command.ts:83-87`, `oc/team/session/send.ts:222-234,255`, `oc/subagents/linger.ts:237`, read). What's missing is `replyTo`, so the question still counts as unanswered.

**What could be better**
1. **Done 2026-11-04.** **Ask before `/quit` stops running work.** Only a streaming reply prompts (`command-dispatch.ts:234`); background subagents and bash jobs are stopped at shutdown (`oc/subagents/tool.ts:197-202`). `/new` already asks (`oc/index.ts:154-167`). New finding. Fix: reuse that check.
2. **Done 2026-11-04 (the text; the grant stays, so a manual-mode child can save its report).** **Correct the spawn prompt for read-only profiles.** A researcher shows "may edit files in the repository and run shell commands" (`s1` permission log; `oc/subagents/profiles.ts:326-335,363` ignores `readOnly`). New finding. Fix: leave out `file.workspace` when `profile.readOnly`.
3. **Done 2026-11-04.** **Close the question when the user answers.** Fix: `/agents tell` accepts a message number and passes `replyTo` (`command.ts:83`).
4. **Partly done 2026-11-04: `/agents kill` asks first. The result was already reported: the stop report is displayed.** **Report the result of a kill.** Fix: report when the process has ended, not just "Stopping…"; ask first on `/agents kill`, as `/processes stop` does.
5. **Done 2026-11-04 (a bare `/rewind` refuses; `/rewind <turns>` runs).** **Make headless `/rewind` consistent.** `ctx.hasUI && !confirm` restores with no prompt (`oc/files/checkpoint-command.ts:169-176`), while `/purge` refuses headless. The invoker typed it, so low. Fix: refuse, or require an explicit count.
6. **Done 2026-11-04.** **Advertise native commands over ACP,** and add one `--help` line pointing to `/help`.
7. **Done 2026-11-04.** **Fix the docs:** add `/agents history`; use `[optional]` in hints.
8. **Done 2026-11-04.** **Print a line on cancel or decline,** and list `/llama` in `/status` (`oc/llama/index.ts:206`, `oc/index.ts:211`).

**Refuted:** "`/purge` has no docs row" (`commands.md:99`, at the frozen ref too). "`/new` guard fails without native features" (no such mode: `--no-extensions` is ignored, `ca/cli/args/flags.ts:228-233`). "`get_commands` should list built-ins" (a prompt can't run them; documented, `packages/coding-agent/docs/rpc.md:18,74`). "`tokens` missing from `/context` completions" (it's a number, `context-controls.ts:7-11`). "A user can't answer a child" (in part; Q7).

### How Octocode did

**Tools.** It used its own research tools throughout: 243 Octocode calls, 0 bash reads, about 2 queries per call, no exact repeated calls, 90 to 97% cache hits, 8 of 8 graded pass, $7.81 in all. Bash was used only for what the tools can't do: running code, counting bytes, and reading JSONL lines in `s1`. Multi-call turns ran from 9% (`s4`) to 38% (`s8`), so `s4` and `s5` could have batched more.

**What failed or misled.**
- `cursor` inside `queries` in `s2`, `s7` and `s8`: each blamed itself, but three of eight points at the tool. `s7` gave up that search.
- Harness, not tools: `s1`'s parent was told "full report follows when this turn ends", and it got only the older report (section 1).
- `.codex/hooks.json` failed on every main-agent call, and no trial mentioned it: every answer said nothing failed. The log entries are in the transcripts, which models don't read.

**Accuracy.** The citations were mostly right, and `exec.ts` was found by real testing. The misses share a pattern: a confident claim where one more read would have settled it.
- `s8`: "isn't documented anywhere" about `/purge`, after loading the file that documents it; concluded a user can't answer from `team/relay.ts`, which handles peers, without following `send.ts`.
- `s6`: benchmarked a copy of the diff in the non-default mode.
- `s7`: multiplied a nesting limit that a child's tool doesn't allow.
- `s5`: estimated memory while pointing at the table that held the answer.

**Delegation (`s8`).** Good. Three independent slices with explicit scope, line anchors and output format, all on the profile's route, in the background. The children cost $0.29 of $1.08. The parent used the wait for its own checks and verified `/rewind`, `/agents tell` and `get_commands` after the reports. Weak spots: it spent about a minute on its own reads before delegating, and its spot checks missed the refuted items above. Its slices never needed sibling messages.

**Live communication (`s1`).** Worked, with the two delivery faults in section 1. The parent corrected itself unprompted as soon as the late report arrived.

**Could not be answered here:** CPU costs (needs profiling); long-session memory growth and leaks; message behavior during compaction or across a resume; how a real user's question travels through a parent (every trial forbade questions); rendering in small terminals and on Windows.
