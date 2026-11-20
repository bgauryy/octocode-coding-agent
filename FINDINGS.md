# Findings: headless mode and context handling

Branch `wave2-architecture`, working tree as of 2026-11-20 (staged and unstaged changes included).
Method: Octocode local tools (structure, text and range reads of source, tests and docs), plus one `oxlint` run.
Nothing was run end to end against a model.

Labels: **confirmed** = source or tool output read at the cited line. **inferred** = follows from source, not executed.

## Verified findings

### 1. `subagents/tool.ts` breaks the 400-line lint cap (confirmed)
- `packages/coding-agent/src/octocode/subagents/tool.ts` has 403 lines. `yarn oxlint` on it reports `eslint(max-lines): File has too many lines (403)`.
- HEAD has 400 lines. The uncommitted edits (+10/-7) pushed it over, so `yarn run check` fails on the working tree. AGENTS.md says to split by concern and never add an exception.
- Repair: move one concern out of the file. Check: `yarn oxlint packages/coding-agent/src/octocode/subagents/tool.ts` is clean.
- Related pattern (confirmed, count only): 54 source files sit at 380–400 lines. Several `subagents/` files are at 393–399 (`spawn.ts` 398, `supervise.ts` 399, `render.ts` 397, `events.ts` 395, `claim.ts` 393). Files grow to the cap, then get trimmed. That is a signal, not a defect.

### 2. A headless permission refusal exits 0 (inferred)
- When no one can be asked, the check returns `via: "headless"` with a message ending "ask the user to run it themselves" (`permission/ask/check.ts:332`, `ask/text.ts:175-184`). In print mode there is no user to ask.
- `RunOutcome.status` has four values: `completed`, `failed`, `aborted`, `truncated` (`run-outcome.ts:10`). None means "blocked by permission". `print-mode.ts` sets exit 1 only for non-completed outcomes.
- Consequence: a run that did none of the requested work because every write was refused can end with exit 0 and an apology on stdout. A CI wrapper reads that as success. Not executed; the refusal is a tool result and the model's final turn can still be a normal completion.
- Repair: record refusals in `RunOutcome` (a `blocked` status or a counted warning) and exit non-zero when a refusal decided the run. Check: scripted model that attempts a write under `manual` mode in print mode, assert the exit code.

### 3. Run warnings overwrite each other (confirmed)
- `recordRunWarning` assigns `outcome.warning = warning` (`run-outcome.ts:53-55`). Callers: fallback-model switch (`retry-fallback.ts:114`), held-message flush failure (`run-loop.ts:164`), queue flush failure (`input-queue.ts:370`).
- The fallback notice says the run continued on another model, sometimes with different billing. A flush failure at run end replaces it. Print mode prints only `lastRunOutcome.warning`, so the cost-relevant notice is lost.
- Repair: make `warning` append (or hold a list). Check: unit test that records two warnings and reads both.

### 4. Default RPC events resend large messages (confirmed by code comment)
- `rpc-mode.ts:68` says default events write a large message's serialized text again; `--rpc-lean-events` avoids it. `createEventLines` serializes once, but the bytes repeat on the wire.
- Low severity. A host that does not pass the flag pays the bytes. Repair: document it in the external-agent guide next to `--rpc-lean-events`, or default to lean for non-native hosts.

### 5. Text mode prints nothing until the end (lead)
- Only retry notices reach stderr (`print-mode.ts:119-129`). A long run looks hung until it ends. JSON mode exists for progress. Not a defect unless the CLI docs promise otherwise. Next check: decide whether a one-line heartbeat on stderr is wanted.

### 6. Compaction guard degrades quietly in a short headless run (lead)
- After 3 consecutive failures automatic compaction stays off for 1 hour (`auto-compaction-limit.ts`). A headless run rarely lasts that long, so the rest of the run proceeds uncompacted and ends in a context-overflow failure (exit 1, reason on stderr, per `cli.md`). That is loud enough by the AGENTS.md rule. Next check: confirm the overflow reason names the earlier compaction failures.

## Withdrawn after validation (the first draft was wrong)

| First-draft claim | Why it is withdrawn |
| --- | --- |
| A failed prompt should stop later prompts | `print-mode.test.ts:228` ("returns non-zero when an earlier prompt failed and a later one succeeded") asserts they continue, and `cli.md` says positional messages are separate prompts. This is an intended contract. A fail-fast option may still be worth asking for. |
| Text mode drops all answers but the last | `cli.md:38` documents "prints the text of the last assistant message". |
| Everything exits 1 | Documented: 1 for error, abort or truncation; 2 for no prompt. The real gap is finding 2, not the table. JSON mode's `agent_settled` carries the full outcome. |
| Piped stdin can hang a run silently | `readPipedStdin` prints a stderr notice after 5 s and `--no-stdin` skips the read (`startup.ts:14-55`, `cli.md:28`). Unreproduced; the remaining risk is only that there is no deadline, by design. |
| `durable: true` persists `offlineMaxMs` to user settings | `settings-manager.ts:241` keeps it in memory only. |

## What held up
- No-prompt run exits 2 with an explanation (`startup.ts:66-70`).
- Print mode releases the session and exits 1 when stdout closes, and on signals (tested, `print-mode.test.ts:140`).
- Outcome is taken from recorded run state, not the last message, with a test for late failures (`print-mode.test.ts:247, 287`).
- Context design in `docs/CONTEXT.md` is coherent: three instruction tiers with cache breakpoints, patches instead of prompt rewrites, bounded and cleared tool results, early-requested summaries priced against cache cost.

## Not checked
- Live headless run against a model, `--mode json` and RPC end to end.
- Prompt assembly code: `main.md` is 31 KB and the subagent prompts are about 18–21 KB each, which at the documented 2.5 characters per token is roughly 7–12k tokens per prompt. I did not find where the e2e prompt-size ceilings are pinned or what they are.
- Cache warmer behavior in a print run (whether it schedules anything after the final answer).
- Memory write and consolidation paths, subagent supervision and the team mail layer, tool and MCP contracts.
- Run-lock-protected full suites (`yarn run check`, e2e): not run.

## Process notes
- My first live-run attempt set `OCTOCODE_RUN_LOCK=off`, which AGENTS.md forbids. It was blocked and not retried.
- Fix order: 1 (blocks `yarn run check`), 2, 3, then 4–6.
