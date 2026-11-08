# Test plan: caching, context, communication, permissions and the coordination graph (2026-11-08)

This plan checks the work of the 2026-11-08 session: the caching review, six TDD swarm phases (A–F), and the new coordinator planning rules. Nothing here is committed. Another session committed part of the tree as `v20.0.1` (`0c2d8b23`) during the work, and other sessions edited unrelated files in parallel.

Run the steps in order. Each step names the command, what a pass looks like, and what a failure means. Everything runs locally. No step costs money except the live checks in [Step 7](#7-live-checks-cost-money-optional), which are optional.

## 0. Before you start

- Make sure no build or generator is running: `pgrep -fl "build|generate:"`. Never run two at once.
- Make sure the sibling `octocode` repo has finished its own rebuild (session `octocode-02`/`octocode-3e`). Its MCP instruction text reaches the prompts.
- Write long output to `.octocode/tmp/` and read it by search.

## 1. Fast checks (about 5 minutes)

| Command (repo root) | Pass |
|---|---|
| `yarn tsc --noEmit -p tsconfig.json` | 0 errors. The 9 Fireworks test errors from the morning catalog refresh were fixed. |
| `yarn oxlint` on the changed files, or `yarn run lint` | No findings. |
| `node scripts/build-workspace-state.mjs --check` | Passes. If stale, run `yarn run generate:workspace` (the `deny_session` approval option reaches the web view through it). |
| `yarn workspace @octocodeai/octocodecode run test:architecture` | 11/11. A Phase B layering violation was fixed by moving `reminder-view.ts` to `octocode/shared/`. |

## 2. New and changed tests, by area (about 10 minutes)

Each file was written red first, then made green. In `packages/ai`, run `yarn vitest run <files>`. In `packages/coding-agent`, run `yarn vitest run --config vitest.octocode.config.ts <files>` for `test/octocode/*`, and `yarn vitest run <files>` for the rest.

| Area | Test files | What they prove |
|---|---|---|
| Provider caching (Anthropic, Bedrock, OpenRouter, Copilot, Vercel, Cloudflare, OpenCode) | `ai: test/cache-edge-anthropic.test.ts` | At most 4 breakpoints in every combination. The 20-block lookback holds. A 1h entry is never placed after a 5m one. Every catalog Claude route gets its longest tier, checked against a literal list of AWS-documented 5m-only Bedrock IDs. Dotted, alias, `@` and `/` profile names resolve correctly. Nova cache points are placed only under its 20K limit. |
| Provider caching (OpenAI, Azure, Codex, Google, Mistral, Grok) | `ai: test/cache-edge-openai.test.ts`, `test/openai-generation-flags.test.ts`, `test/payload-layers.test.ts` | GPT-5.6+ uses explicit 12h, including `gpt-6.1-terra`. Older OpenAI models get 24h. Azure gets 24h on Microsoft's list, an opt-in for custom deployments, an explicit-12h opt-in per deployment, and Astra breakpoints without the `ttl` key. The cache key stays stable. |
| SDK upgrade follow-ups | `ai: test/google-stop-reason-map.test.ts`, `test/google-continuation.test.ts` | Google `CONTINUATION` maps to `length`. `automaticContinuation` is set to `false` explicitly. |
| Harness and cache defaults | `test/octocode/cache-edge-harness.test.ts`, `test/cache-configuration.test.ts`, `test/session-fork-cache-key.test.ts` | Long/long by default for `--print`, its children and grandchildren. TTL planning uses the resolved capabilities: about 534 models now plan their long tier, up from 32. Marker models with no long tier plan 5m. The `/status` text matches what the adapter sends. The resume key is stable. |
| Profiler | `test/octocode/profiler-cache-edge.test.ts` | Compactions are no longer reported as "message change". Every cold start names its cause, down to the tool that changed. Lifetimes are correct for 1h, 12h and 24h. Minimum cacheable sizes are correct. Session cost includes compaction, warming and branch summaries. |
| Compaction | `test/octocode/compaction-flow-edge.test.ts`, `test/compaction-serialization.test.ts`, `test/bug-report-summary.test.ts`, `test/side-questions.test.ts` | The shared summary request matches the live prefix. A model switch counts as cold, but a virtual (routed) model does not. A standalone summary sends no cache write. External text is never labeled `[User]`, for every line terminator, VT, FF and FS/GS/RS included. |
| Internal communication | `test/octocode/comm-internal-edge.test.ts` | No false "never delivered" dead letters. Dropped questions name the recipient and say read or unread. A child whose coordinator left is told so. A coordinator's question ends a child's hold. |
| External communication and identity | `test/octocode/comm-external-edge.test.ts`, `test/octocode/comm-external-identity.test.ts`, `test/octocode/external-message-full.test.ts`, `test/octocode/ask-card.test.ts`, `test/octocode/api-turn-ceiling.test.ts`, `webview: test/session-state-rendering.test.tsx` | `external.call` and `turn.abort` go through admission. Reads are open but audited. The nonce check verifies the claimed peer. Grants are keyed by the verified id and pid. Duplicate or forged records fail closed. Tickets are bound to the endpoint they were issued for (Phase F). "Deny for session" exists and renders with a danger tone. |
| Permissions | `test/octocode/permission-layers-edge.test.ts`, `test/octocode/awk-guard.test.ts`, `test/octocode/shell-mutation.test.ts`, `test/octocode/permission-git-forms.test.ts` | A timer's until-command meets the same invariants as bash. Hidden merges are caught (heredoc, `echo\|sh`, here-string, `find -exec`). `sqlite3` writes are caught. The awk fail-safe allowlist applies to read-only and isolated children only (Phase F). `browser.cookies` is not grantable to children. |
| awk reading after Phase F | `test/octocode/awk-guard.test.ts` ("keeps the in-place targets … next to an option outside the allowlist") | An option outside the allowlist (`-b`, `--posix`, `-W posix`, `-f p.awk`) keeps the strict reason but no longer hides the files `gawk -i inplace` rewrites, so workspace reservations and receipts still see them. I fixed this myself after the Phase F review rejected the earlier version: 5 tests went red, then green; 523 pass across awk-guard, permission-layers-edge, shell-mutation, permission-git-forms and read-hint. |
| Bypass merge | the merge tests under `test/octocode/` (grep `worktree.merge`, `bypass-merged`) | Readiness runs before every merge, again after approval, and against the worktree's own backlog. A bypass merge is announced, audited `via: bypass`, and shown in `/status`. |
| Coordination graph | `test/octocode/delegation-graph.test.ts`, `test/octocode/coordination-graph-edge.test.ts`, `test/octocode/coordination-graph-wake.test.ts`, `test/octocode/coordination-graph-pace.test.ts`, `test/octocode/graph-watch-linked.test.ts` | The plan/check/run graph rules exist in the main prompt only. Blocked items are refused before approval. One child per item. Ready, closed and owner-ended wakes fire and are paced. Wakes are retried. Completions from outside the session wake the coordinator. In-batch `dependsOn` by title works. A timer wakes on `closed`. |
| Instructions | `test/octocode/instructions-context-edge.test.ts`, `test/octocode/prompt*.test.ts`, `test/octocode/final-prompts-fresh.test.ts` | No duplicated rules. The `harnesses` section is declared. Peer waits are covered. The Harnesses line comes from `instructions/` and is absent from child prompts. `timer` is enabled whenever `agent` is. |
| Catalog tests repointed | `ai: test/fireworks-models.test.ts`, `test/providers.test.ts`, `test/anthropic-adaptive-thinking-models.test.ts`, `test/anthropic-empty-thinking-signature-compat.test.ts` | They name models that still exist (`minimax-m3`). This is a data change from the 08:30 catalog refresh, not a behavior change. |
| e2e flake fixed | `test/octocode/e2e-all-tools.test.ts -t "askUser: over RPC"` (`vitest.e2e.config.ts`) | Parses only complete stdout lines. Run it 3 times; it should pass every time. |

## 3. Generated files

| Command | Then check |
|---|---|
| `yarn workspace @octocodeai/octocodecode run generate:prompts` | `.octocode/tmp/agent-prompts/main/system.md` contains the plan/check/run graph bullets. Child `system.md` files do not. `final-prompts-fresh` and `prompt-size` tests pass. Main grew about 660 B (graph rules) plus about 50 B (`dependsOn` text). |
| `yarn run generate:workspace` | `check:workspace` passes. |
| `generate:models` (already run in Phase D) | The Bedrock catalog keeps Opus 4.1 and Sonnet 4.5 and drops only end-of-life Sonnet 4. `gpt-6.1-terra` carries its flags. The generated data is git-ignored, so check it with the tests in Step 2. |

## 4. Full suites (only if you want the complete picture)

These are costly. They passed earlier on 2026-11-08, before Phases B–F: native 9,084, core 4,563, e2e 442 with 2 flakes (fixed or load-related). Run them in the background, one at a time:

```bash
yarn run check
(cd packages/ai && yarn vitest run)
(cd packages/coding-agent && yarn vitest run --config vitest.octocode.config.ts)
(cd packages/coding-agent && yarn vitest run)
yarn workspace @octocodeai/octocodecode run test:e2e
```

Known: `team-interpreter-parsed` "gates a 2000-stage pipeline quickly" is timing-sensitive (400 ms limit) and failed once under heavy load. The real-browser e2e can leave a Chrome process behind under load.

## 5. Manual checks (behavior a unit test cannot show)

1. **Bypass merge notice.** Start with `--dangerously-skip-permissions`, have a child finish in a worktree, then merge it. Expect a visible "merged … without asking (bypass)" notice, a `via: bypass` entry in `/permissions log`, and the merge line in `/status`. Make the worktree dirty and try again: the merge must be refused, with the failing check and the next step.
2. **Graph never stalls.** Plan three items where B depends on A. Finish A from another session or the web board. The coordinator should wake with "B is ready". Stop A's child without finishing: expect the owner-ended notice.
3. **Deny for session.** From a second terminal, run `octocode-api send` to the session in workspace mode and pick "Deny messages from … for this session". A second send must be refused without a dialog, and the sender should read the session wording.
4. **Read API audit.** Call `status` or `messages.list` from another process. It runs without a dialog and shows in the session's `octocode-external` entries. `turn.abort` asks outside `full` mode.
5. **awk in a read-only child.** `awk -F: '{print $1}' f` runs, while `awk '$1 > 5' f` is refused or asked. In a normal workspace session, `awk '$1 > 5' f` must not ask.
6. **Profiler.** Run `node packages/coding-agent/dist/bundle/cli.js profile --insights` after a build. Compactions now show as low "compaction rewrote …", cold starts name their cause, the two former "high" dead letters are gone, and the cost line splits turns, compaction and warming.

## 6. Coordinator planning prompt

The main prompt now tells the coordinator to:

- do the work itself unless a child saves more than it costs;
- plan multi-child work as one backlog graph (owner, files, check, real `dependsOn`) and show it as "item, owner, depends on";
- check the graph before starting it;
- run it in waves with one build owner;
- send a failure back to the child that owns the item.

Judge this by behavior, with the ship eval (dry run first: `node scripts/agent-eval/run.mjs --dry-run --model <id>`; `--live` costs money).

## 7. Live checks (cost money, optional)

- **Nova:** one Converse request on Nova Pro with more than 20K tokens before the system point. Confirms AWS accepts or ignores a point past its cap. We currently skip such points.
- **GitHub Copilot and Vercel 1h:** run `anthropic-long-cache-retention-e2e.test.ts` with credentials. Both send 1h by default, but neither documents it.
- **OpenAI sibling keys:** pre-5.6 models above ~15 RPM per shared `prompt_cache_key` may spill to other machines. Watch the hit rate when 3 or more siblings run at once.

## 8. Still open (decisions for you)

| # | Question | Current behavior |
|---|---|---|
| 1 | `/login` or `/providers`? | Another session renamed it to `/providers`, while memory says `/login`. Untouched. |
| 2 | Anthropic SDK 1.x | Held at 0.137. 1.x sends `Authorization: Bearer` and drops sampling parameters, so it needs a planned migration with live checks per provider. |
| 3 | Queue blocked starts | Refused before approval, plus wakes on every prerequisite outcome. No auto-start queue. |
| 4 | A raw `git merge` through bash in bypass | Runs unasked and audited `via: bypass`, but cannot be readiness-checked in advance. |
| 5 | awk fail-safe cost | Read-only and isolated children are refused awk comparisons and `\|` regexes. Workspace is unchanged. |
| 6 | Proactive compaction while the cache is cold | Not built. Measure first. |
| 7 | Identity boundary | A same-user process that rewrites a session's files on disk can still pass as that session: it can overwrite the caller's own registry file, or replace a session's socket file at its registered path. Node exposes no peer credentials. Documented in `docs/permissions.md` and `session-api.md`. |

## Where the details are

- Caching facts and measured data: the session scratchpad `caching-facts.md`, plus `.octocode/tmp/profile.json` and `.octocode/tmp/child-first-requests.json`.
- Swarm digests: `.octocode/tmp/swarm2-digest.txt`, `fix-digest.txt`, `phaseA-digest.txt`, `phaseB-digest.txt`, `phaseC-digest.txt`.
- The earlier full-verification logs: `.octocode/tmp/verify/`.
- Orchestration RFC (Proposed): `.octocode/octocode-rfc-generator/2026-11-08-swarm-orchestration/RFC.md`.
