---
status: Draft
question: "Test plan: Octocode agentic tools and flows"
---

# Test plan: Octocode agentic tools and flows

Test the native tools and the flows that connect delegation, messages, reservations, worktrees, permissions, waiting and recovery. The target is commit `f473b1aa7f423ac3b052bf9cfc7f2459eea7a01a` **plus the current dirty implementation**, reviewed on 2026-11-12. Success requires the cases below to pass with evidence and no source/test changes. This is a plan, not a test-results report.

## Answer

**Draft: 24 existing cases — 20 P0, 4 P1; 3 unit, 10 integration, 11 end-to-end.** P0 protects files, approval boundaries, report delivery, session identity and owned-process cleanup. P1 covers check-in efficiency, hook selection, MCP presentation and RPC questions. G1's wait-identity races and G2's shutdown/cancellation coverage prevent a complete P0 sign-off; existing green suites alone would not close them. G6 also requires repinning the concurrently changing working tree before execution.

## Scope

Repository: `/Users/bgaryy/code/octocodecode`. Keep the dirty changes: testing a clean HEAD would omit the implementation this plan inspected. Pin tracked changes and untracked inputs with:

```sh
python3 - <<'PY'
import hashlib, pathlib, subprocess
excluded={'TEST_PLAN.md','TEST_PLAN-results.md','.octocode/REFLECT.md'}
payload=subprocess.check_output(['git','diff','--binary','HEAD','--','.',*[f':(exclude){p}' for p in sorted(excluded)]])
for name in sorted(subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z']).split(b'\0')):
    if name and name.decode() not in excluded:
        payload+=b'\0'+name+b'\0'+hashlib.sha256(pathlib.Path(name.decode()).read_bytes()).digest()
print(hashlib.sha256(payload).hexdigest())
PY
```

Expected SHA-256 at the review checkpoint: `94a50d41cfa35563f458561955253383970e790c93577a583feb05c2cc96c06b`. The fingerprint excludes only this plan, its results and the reflection log; ignored build outputs are not pinned. Untracked source files are included. A revision or fingerprint mismatch stops execution until the plan is repinned, without resetting user changes; see G6.

Evidence: registration `packages/coding-agent/src/octocode/index.ts:223` → unified dispatch `packages/coding-agent/src/octocode/agent-tool.ts:132` → launch validation `packages/coding-agent/src/octocode/subagents/spawn.ts:70`; reservation revalidation `packages/coding-agent/src/octocode/team/tools.ts:124`; public contracts `packages/coding-agent/docs/native-features.md:100`. Case-level test anchors below supply the executable oracles. Commands come from `package.json:16`, `packages/coding-agent/package.json:51`, `DEVELOPMENT.md:9`, `packages/coding-agent/vitest.octocode.config.ts:9` and `packages/coding-agent/vitest.e2e.config.ts:16`.

## Executor contract

- **Objective / inputs:** an agent or person with this plan and the pinned working tree runs TC-01–TC-24 and reports actual results. Source, tests and assertions remain read-only.
- **Tools / environment:** shell, Python 3 (fingerprint only), Git, Yarn 4.18.1, Node **24.15+ within Node 24**, `rg`, `fd`, POSIX process groups, `ps` and loopback sockets. No browser, cloud model, vendor login or real credentials are needed for these selected cases. Unsupported process inspection blocks TC-07/TC-23; it is not a pass.
- **Provisioning:** activate Node 24, check `node --version` and `yarn --version`, then follow `DEVELOPMENT.md:9`: sibling Octocode packages on the documented branch must already be built, including native binaries. If dependencies/catalog are absent, use `yarn install --immutable` and `yarn run hydrate:model-data`; catalog hydration needs network. Confirm `yarn run check:model-data` exits 0 before an offline run. Never rebuild the sibling or refresh provider catalogs midway through a run.
- **Check-back:** confirm `git rev-parse HEAD` and the diff digest above, record dirty/untracked inputs, then restate the objective and success criteria. Capture `git status --porcelain=v1 --untracked-files=all` and `git diff --binary HEAD` before and after. Do not stash, clean or reset the user's work.
- **Setup:** from the repository root, use the following shell session. The wrappers remove inherited credentials and identity; each configured suite also creates isolated homes/databases (`packages/coding-agent/test/octocode/setup-env.ts:7`). A case's Given adds its existing fixture to this common setup.

```sh
plan_run_root="$(mktemp -d /tmp/octocode-agentic-plan.XXXXXX)"
mkdir -p "$plan_run_root/home" "$plan_run_root/tmp" "$plan_run_root/config" "$plan_run_root/agent" "$plan_run_root/octocode"
plan_vitest() {
  env -i PATH="$PATH" HOME="$plan_run_root/home" USERPROFILE="$plan_run_root/home" TMPDIR="$plan_run_root/tmp/" XDG_CONFIG_HOME="$plan_run_root/config" OCTOCODE_HOME="$plan_run_root/octocode" OCTOCODE_CODING_AGENT_DIR="$plan_run_root/agent" OCTOCODE_AGENT_DB="$plan_run_root/workspaces.db" COREPACK_ENABLE_NETWORK=0 yarn workspace @octocodeai/octocodecode run vitest run --reporter=verbose "$@"
}
ntest() { plan_vitest --config vitest.octocode.config.ts "$@"; }
etest() { plan_vitest --config vitest.e2e.config.ts "$@"; }
```

- **Execution:** cases are independent except explicit negative companions. Run serially, once each; do not run a build concurrently. For each When, save stdout/stderr and exit status as `TC-NN.log` under the run directory. Preserve timeout, unhandled-error and cleanup output. A compound When requires both commands to pass. Do not enable retries, snapshot updates, `--passWithNoTests` or ignored errors.
- **Common oracle:** exit 0, at least one selected test actually passes, every selected assertion passes, zero unhandled errors and zero unexplained selected-test skips. The case's Then must also hold. A missing fixture/dependency is blocked; an executed assertion or timeout failure is fail. Record platform skips as blocked.
- **Cleanup / evidence:** existing fixture hooks close their own resources. Inspect owned pid/worktree evidence after failures; stop only resources positively identified as belonging to this run. Keep logs until reported; remove only the exact newly created `plan_run_root` after preserving evidence. Never target live sessions or the real home.
- **Report / Definition of Done:** save `TEST_PLAN-results.md` next to this plan using Results format, with every case, gate and gap accounted for. A plan status is not an execution verdict.

## Features

P0 means a failure can lose work, bypass authority, corrupt shared state or strand owned processes; concurrency, external input and lifecycle branching make these failures plausible. P1 reduces the risk of a user-visible workflow failure or wasted requests. Priorities below apply to every mapped case unless its summary says P1.

| ID | Feature / documented claim | Source | Risk / priority | Cases |
| --- | --- | --- | --- | --- |
| F1 | Native selection, real tool effects, file verification; bash, file, web, mcp, backlogPlan, backlog, timer, archive, memory, askUser, skill, models, compact, agent | `packages/coding-agent/docs/native-features.md:100`; `packages/coding-agent/test/octocode/e2e-all-tools.test.ts:113` | Side effects/contract, P0 | 01, 24 |
| F2 | Unified agent types, flat schema and batch defaults/outcomes | `packages/coding-agent/src/octocode/agent-tool.ts:132`; `packages/coding-agent/test/octocode/agent-tool-batch.test.ts:56` | Invalid dispatch/hidden child failure, P0 | 02, 03 |
| F3 | Slot queues, limits and cancellation | `packages/coding-agent/src/octocode/subagents/spawn.ts:65`; `packages/coding-agent/docs/native-features.md:271` | Leaked capacity/unbounded work, P0 | 04 |
| F4 | Honest final reports, pending jobs and retry recovery | `packages/coding-agent/docs/native-features.md:300`; `packages/coding-agent/test/octocode/subagent-job-hold.test.ts:53`; `packages/coding-agent/test/octocode/orchestration-recovery.test.ts:55` | Lost/false completion, P0 | 05, 06, 22 |
| F5 | Stop, SIGTERM and parent death | `packages/coding-agent/test/octocode/e2e-subagent-lifecycle.test.ts:91`; `packages/coding-agent/test/octocode/e2e-all-tools.test.ts:489` | Orphan processes, P0 | 07 |
| F6 | Child resume retains earlier context | `packages/coding-agent/docs/native-features.md:313`; `packages/coding-agent/test/octocode/e2e-subagent-lifecycle.test.ts:132` | Wrong/lost session, P0 | 08 |
| F7 | Parent/sibling routing, busy steering, idle wake and isolated children | `packages/coding-agent/docs/native-features.md:718`; `packages/coding-agent/test/octocode/e2e-a2a-messaging.test.ts:76` | Cross-tree disclosure/lost steering, P0 | 09, 10 |
| F8 | Reservations are atomic and rechecked after approval | `packages/coding-agent/docs/native-features.md:278`; `packages/coding-agent/test/octocode/tool-gates-revalidate.test.ts:36` | Concurrent overwrites, P0 | 11, 12 |
| F9 | Isolated snapshots, worker-only refs and safe landing | `packages/coding-agent/test/octocode/worktree.test.ts:35` | Parent data loss, P0 | 13 |
| F10 | Persistent timers, one claimant, cancellation and check budgets | `packages/coding-agent/docs/native-features.md:131` | Duplicate wakes/unbounded waiting or spend, P0 | 14; G1–G2 |
| F11 | Check-ins, soft/hard budgets and explicit grants | `packages/coding-agent/docs/native-features.md:443`; `packages/coding-agent/test/octocode/subagent-budget.test.ts:50` | Hung/wasteful conversations, P1 | 15 |
| F12 | Permission refusals and profile-gated hooks | `packages/coding-agent/docs/native-features.md:18`; `packages/coding-agent/test/octocode/e2e-permission.test.ts:158` | Approval bypass P0; hook selection P1 | 16, 17 |
| F13 | Deferred MCP exposure; selected servers, pinned skills and live narrowing | `packages/coding-agent/docs/native-features.md:267`; `packages/coding-agent/test/octocode/e2e-mcp-deferred.test.ts:33` | Capability escape P0; presentation P1 | 18, 19 |
| F14 | Compaction retains its focus and resumes the task | `packages/coding-agent/test/octocode/e2e-all-tools.test.ts:421` | Lost task/context, P0 | 20 |
| F15 | RPC questions return an answer; headless supplies no approval | `packages/coding-agent/test/octocode/e2e-all-tools.test.ts:291,456` | Incorrect answer delivery, P1 | 01, 21 |
| F16 | External ACP crash recovery preserves evidence without replay | `packages/coding-agent/test/octocode/external-acp-reliability.test.ts:37` | Repeated side effects/lost evidence, P0 | 23 |

## Cases

All status values below describe coverage that already exists; none means a case passed in this planning pass. Test anchors in the case blocks are relative to `packages/coding-agent/test/octocode/`; commands use package-relative paths through the setup wrappers.

| ID | Title | Priority | Level | Technique | Status |
| --- | --- | --- | --- | --- | --- |
| TC-01 | Native tool loop and error recovery | P0 | end-to-end | contract / negative | existing |
| TC-02 | Unified agent schema rejects foreign fields before dispatch | P0 | unit | partition / negative | existing |
| TC-03 | Task batches retain per-child outcomes | P0 | unit | decision table / negative | existing |
| TC-04 | Capacity queues return slots after stop and setup failure | P0 | integration | state / cancellation | existing |
| TC-05 | Reports preserve failures and subsequent recovery | P0 | unit | state / regression | existing |
| TC-06 | Pending work holds a child without replacing its report | P0 | integration | state / timeout | existing |
| TC-07 | Stop and coordinator death leave no owned processes | P0 | end-to-end | fault injection / cleanup | existing |
| TC-08 | Resume retains the child's prior transcript | P0 | end-to-end | compatibility / state | existing |
| TC-09 | Team mail steers busy children and isolates session trees | P0 | end-to-end | routing / negative | existing |
| TC-10 | Finished and isolated children remain correctly addressable | P0 | end-to-end | state / isolation | existing |
| TC-11 | Path reservation queues acquire all or none | P0 | integration | concurrency / cancellation | existing |
| TC-12 | Approval is revalidated against new reservations | P0 | integration | race / negative | existing |
| TC-13 | Isolated work preserves parent bytes and failed landing evidence | P0 | integration | invariant / conflict | existing |
| TC-14 | Timers wake once, cancel cleanly and bound model checks | P0 | integration | boundary / concurrency | existing |
| TC-15 | Check-ins and request grants keep the parent responsive | P1 | end-to-end | budget / negative | existing |
| TC-16 | Headless permissions refuse mutations without implied approval | P0 | end-to-end | decision table / negative | existing |
| TC-17 | Child hooks run only when the profile enables them | P1 | end-to-end | decision table / negative | existing |
| TC-18 | Deferred MCP calls preserve prefixes and child server selection | P1 | end-to-end | contract / negative | existing |
| TC-19 | Children inherit pinned skills and live permission narrowing | P0 | integration | identity / negative | existing |
| TC-20 | Compaction resumes the task from its saved summary | P0 | end-to-end | state / recovery | existing |
| TC-21 | askUser round-trips the exact RPC answer | P1 | end-to-end | protocol / negative | existing |
| TC-22 | Exhausted report delivery retries do not lose or duplicate work | P0 | integration | fault injection / recovery | existing |
| TC-23 | ACP crashes retain evidence without replaying prompts | P0 | integration | fault injection / compatibility | existing |
| TC-24 | File writes verify actual bytes and refuse stale context | P0 | integration | invariant / race | existing |

#### TC-01 Native tool loop and error recovery

- **Covers / priority:** F1, P0, end-to-end; `e2e-all-tools.test.ts:113,377`. **Given:** common setup plus the existing loopback page and scripted parent/child fixtures; all native tool examples are supplied by NATIVE.
- **When:** `etest test/octocode/e2e-all-tools.test.ts -t 'every native tool, in one real process'`.
- **Then:** declared native names equal NATIVE keys; every success and refusal matches its oracle; stdout is exactly parent-final-text; the child actually returns from-child.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-01.log`, then use common cleanup.

#### TC-02 Unified agent schema rejects foreign fields before dispatch

- **Covers / priority:** F2, P0, unit; `agent-tool-schema.test.ts:191,210`. **Given:** common setup plus the unified tool fixture with a spy on every mode.
- **When:** `ntest test/octocode/agent-tool-schema.test.ts -t 'refuses another type|hands each mode|same flat object|starter-only interrupt'`.
- **Then:** task/external/coordinate/message receive their own field names and agentType; unknown types, foreign fields and the old input envelope fail before any mode executes; leaf sessions omit interrupt.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-02.log`, then use common cleanup.

#### TC-03 Task batches retain per-child outcomes

- **Covers / priority:** F2, P0, unit; `agent-tool-batch.test.ts:56`. **Given:** common setup plus the batch fixture with overlapping asynchronous starts, malformed rows and a crashed child.
- **When:** `ntest test/octocode/agent-tool-batch.test.ts -t 'agent task batch'`.
- **Then:** background starts overlap; foreground waits for every row; defaults yield to entry overrides; valid siblings continue after a bad row; failed and crashed children retain their goal and outcome instead of reading ok.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-03.log`, then use common cleanup.

#### TC-04 Capacity queues return slots after stop and setup failure

- **Covers / priority:** F3, P0, integration; `subagent-tool.test.ts:636,682,773,862`. **Given:** common setup plus the suite's one-slot queue and fault-injection fixtures; maxChildren/maxCost are configured only in fixture settings.
- **When:** `ntest test/octocode/subagent-tool.test.ts -t 'refuses unknown profiles|background calls past the limit|opt-in subagents limits|gives the slot and the name back'`.
- **Then:** queued background calls return distinct ids; foreground callers wait; stopping a queue entry starts no child; ending its originating turn does not cancel session-owned queued work; setup errors return the name and slot; configured child/cost caps refuse extra work.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-04.log`, then use common cleanup.

#### TC-05 Reports preserve failures and subsequent recovery

- **Covers / priority:** F4, P0, unit; `subagent-report.test.ts:11,91,101`. **Given:** common setup plus the report tracker with an earlier completed report, failed follow-up and later recovery.
- **When:** `ntest test/octocode/subagent-report.test.ts -t 'outcome word|trailing outcome line|failed reply|incremental subagent reports'`.
- **Then:** the latest outcome is independent of the preview; a failed follow-up keeps the earlier report and full error; recovery clears the failure; an empty final follow-up cannot reuse an old completed outcome.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-05.log`, then use common cleanup.

#### TC-06 Pending work holds a child without replacing its report

- **Covers / priority:** F4, P0, integration; `subagent-job-hold.test.ts:53,101,124; waiting-guards.test.ts:91,144`. **Given:** common setup plus the job-hold fixture and fake-clock wait fixtures; use their existing deadlines.
- **When:** `ntest test/octocode/subagent-job-hold.test.ts test/octocode/waiting-guards.test.ts -t 'holds the run until|warns once when the job outlasts|holds again|waiting-only final text|an until timer'`.
- **Then:** job completion reaches a subsequent child turn; an overlong job warns once and is stopped at final run end; waiting-only text preserves the real report; waits on ended agents or unknown items create no timer; valid waits do create one.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-06.log`, then use common cleanup.

#### TC-07 Stop and coordinator death leave no owned processes

- **Covers / priority:** F5, P0, end-to-end; `e2e-subagent-lifecycle.test.ts:91; e2e-all-tools.test.ts:489`. **Given:** common setup plus POSIX process-group and ps access; the harness records only its own child/job pids.
- **When:** `etest test/octocode/e2e-subagent-lifecycle.test.ts test/octocode/e2e-all-tools.test.ts -t 'coordinator that exits|coordinate stop ends'`.
- **Then:** coordinate stop terminates the child and its command; SIGTERM leaves no sandbox survivors; after SIGKILL all captured child/job pids disappear and the existing elapsed-time assertion stays below 25,000 ms.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-07.log`, then use common cleanup.

#### TC-08 Resume retains the child's prior transcript

- **Covers / priority:** F6, P0, end-to-end; `e2e-subagent-lifecycle.test.ts:132`. **Given:** common setup plus a child that already answered done: earlier answer marker; TC-01 supplies the invalid-resume companion.
- **When:** `etest test/octocode/e2e-subagent-lifecycle.test.ts -t 'a resumed child'`.
- **Then:** the first resumed request contains an assistant turn, the earlier answer and original task; its last user text contains the new task; the parent exits 0; unknown resume ids remain rejected by TC-01.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-08.log`, then use common cleanup.

#### TC-09 Team mail steers busy children and isolates session trees

- **Covers / priority:** F7, P0, end-to-end; `e2e-a2a-messaging.test.ts:76`. **Given:** common setup plus the fixture's parent, busy child, sender sibling and unrelated session tree.
- **When:** `etest test/octocode/e2e-a2a-messaging.test.ts -t 'parent and children talk both ways'`.
- **Then:** parent and sibling mail reach a later child step; request-step ids are unique; only the parent is labelled coordinator; outsider mail is refused and the outsider inbox remains empty; wake reaches the idle parent.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-09.log`, then use common cleanup.

#### TC-10 Finished and isolated children remain correctly addressable

- **Covers / priority:** F7, P0, end-to-end; `e2e-a2a-resume.test.ts:38; e2e-a2a-worktree.test.ts:47`. **Given:** common setup plus the completed reachable child and the separate isolated-sibling team fixtures; TC-01 supplies unknown/closed-recipient refusals.
- **When:** `etest test/octocode/e2e-a2a-resume.test.ts test/octocode/e2e-a2a-worktree.test.ts -t 'is resumed by|see their coordinator'`.
- **Then:** a parent's message resumes its reachable completed child and is recorded for it; isolated siblings discover and exchange replies with their own coordinator and each other; invalid recipients remain rejected in TC-01.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-10.log`, then use common cleanup.

#### TC-11 Path reservation queues acquire all or none

- **Covers / priority:** F8, P0, integration; `subagent-reservation-queue.test.ts:107,168,201`. **Given:** common setup plus a sibling holding a.ts, a queued request for a.ts and b.ts, and the fixture's competing peer.
- **When:** `ntest test/octocode/subagent-reservation-queue.test.ts -t 'background start|cancelling a start|holder that is not'`.
- **Then:** the queued child holds no partial lease; release grants its full set; cancelling starts nothing and leaves the holder intact; a peer taking the path before acquisition causes a refusal report while the peer's lease remains.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-11.log`, then use common cleanup.

#### TC-12 Approval is revalidated against new reservations

- **Covers / priority:** F8, P0, integration; `tool-gates-revalidate.test.ts:36`. **Given:** common setup plus a bash call approved before a peer locks its write target.
- **When:** `ntest test/octocode/tool-gates-revalidate.test.ts -t 'a bash call approved before'`.
- **Then:** revalidation returns block: true with reserved when the peer takes shared.txt; reserving other.txt leaves the unrelated write allowed.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-12.log`, then use common cleanup.

#### TC-13 Isolated work preserves parent bytes and failed landing evidence

- **Covers / priority:** F9, P0, integration; `worktree.test.ts:35,62,197,226,294`. **Given:** common setup plus fixture Git repositories with staged, unstaged and untracked baseline files, child edits and a merge conflict.
- **When:** `ntest test/octocode/worktree.test.ts -t 'snapshots staged|refuses a working-copy snapshot|lands the change|never overwrites an unmerged ref|aborts a conflicting merge'`.
- **Then:** snapshotting leaves the parent's index and unstaged diff byte-identical; only worker edits are exported; custom clean filters are refused before execution; reused ids cannot overwrite refs; conflicting landing aborts and preserves the ref and parent tree.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-13.log`, then use common cleanup.

#### TC-14 Timers wake once, cancel cleanly and bound model checks

- **Covers / priority:** F10, P0, integration; `timer/timer.test.ts:60,123,252; timer-until.test.ts:58,172,319,510`. **Given:** common setup plus the timer suites' fake clocks, two SQLite connections and injected check model; no real model credentials.
- **When:** `ntest test/octocode/timer/timer.test.ts test/octocode/timer-until.test.ts -t 'timers queries|timer scheduler|timer tool in a session|closed list of until conditions|event sources only poke|agentic check|timer tool and check'`.
- **Then:** two connections claim a wake once; cancellation prevents later wakes; missed fires coalesce; intervals below 30 s and an 11th active timer fail; unchanged evidence makes no repeated judgment; malformed verdicts become unsure; configured judgment/spend/failure caps end the wait; check opt-in cannot come from project settings.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-14.log`, then use common cleanup.

#### TC-15 Check-ins and request grants keep the parent responsive

- **Covers / priority:** F11, P1, end-to-end; `e2e-check-in.test.ts:55; e2e-budget-conversation.test.ts:80; subagent-budget.test.ts:50,188`. **Given:** common setup plus the scripted check-in/grant conversations and fake request-budget unit fixture.
- **When:** `ntest test/octocode/subagent-budget.test.ts -t 'RequestBudget|RunningBudgets|coordinate grant' && etest test/octocode/e2e-check-in.test.ts test/octocode/e2e-budget-conversation.test.ts`.
- **Then:** soft/hard limits steer/stop once; invalid grants and foreign/nonrunning children are refused; a valid grant crosses the former hard limit; a background check-in costs the parent no request; foreground asks for a blocked report; setting 0 sends no check-in.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-15.log`, then use common cleanup.

#### TC-16 Headless permissions refuse mutations without implied approval

- **Covers / priority:** F12, P0, end-to-end; `e2e-permission.test.ts:158`. **Given:** common setup plus only the suite's disposable app.ts and marker files; its mkfs.zzz command is deliberately nonexistent.
- **When:** `etest test/octocode/e2e-permission.test.ts -t 'permission modes in a headless run'`.
- **Then:** manual child writes/shell calls produce NEEDS_APPROVAL and create no markers; workspace mode preserves app.ts when a destructive command needs approval; manual main gives the documented allowed mode; full-mode fixture execution carries its shell.destructive audit.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-16.log`, then use common cleanup.

#### TC-17 Child hooks run only when the profile enables them

- **Covers / priority:** F12, P1, end-to-end; `e2e-subagent-hooks.test.ts:75`. **Given:** common setup plus the fake HOME Claude settings and recording hooks created by the suite.
- **When:** `etest test/octocode/e2e-subagent-hooks.test.ts -t 'subagent hooks in a real child process'`.
- **Then:** enabled children record SubagentStart and SubagentStop; hooks-off children record neither; the parent's startup output contains no spurious hook warning.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-17.log`, then use common cleanup.

#### TC-18 Deferred MCP calls preserve prefixes and child server selection

- **Covers / priority:** F13, P1, end-to-end; `e2e-mcp-deferred.test.ts:33,131; subagent-task-servers.test.ts:42`. **Given:** common setup plus the local secretecho MCP fixture and per-task server-selection fixtures.
- **When:** `ntest test/octocode/subagent-task-servers.test.ts -t 'per-task MCP servers' && etest test/octocode/e2e-mcp-deferred.test.ts`.
- **Then:** deferred discovery returns the upstream description/schema; the call result reaches request 3; all three prompt/declaration prefixes are identical; a task names only permitted servers; unknown/disabled names and unsupported lean/resume combinations fail before launch.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-18.log`, then use common cleanup.

#### TC-19 Children inherit pinned skills and live permission narrowing

- **Covers / priority:** F13, P0, integration; `subagent-skill-inheritance-session.test.ts:313,401,415,507,523`. **Given:** common setup plus the actual child-launch fixture, captured plugin skills and replaced discovery symlink; no user skill directory is edited.
- **When:** `ntest test/octocode/subagent-skill-inheritance-session.test.ts -t 'inherits accepted|canonical skill identity|inherits only an explicit skill subset|live parent permission narrowing|malformed private snapshot'`.
- **Then:** accepted qualified skills reach the child; an empty explicit subset loads none; retargeting cannot substitute RETARGET_BODY for CANONICAL_BODY; a parent narrowed to workspace never gives the child full; a malformed child snapshot exits nonzero with Invalid or oversized child skill resource snapshot and zero provider requests, while the main-session control still makes one request.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-19.log`, then use common cleanup.

#### TC-20 Compaction resumes the task from its saved summary

- **Covers / priority:** F14, P0, end-to-end; `e2e-all-tools.test.ts:324,421`. **Given:** common setup plus the scripted full-context fixture, focus keep the marker and its synthetic summary; TC-01 supplies under-50-percent refusal.
- **When:** `etest test/octocode/e2e-all-tools.test.ts -t 'compact: a full context'`.
- **Then:** the queued call reaches a summary request carrying its focus; the session JSONL contains a compaction with scripted summary; the resumed request contains that summary; stdout equals the fixture's RESUMED_TEXT, not queued-status.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-20.log`, then use common cleanup.

#### TC-21 askUser round-trips the exact RPC answer

- **Covers / priority:** F15, P1, end-to-end; `e2e-all-tools.test.ts:291,456`. **Given:** common setup plus the loopback RPC process fixture; TC-01 supplies headless and empty-question refusals.
- **When:** `etest test/octocode/e2e-all-tools.test.ts -t 'askUser: over RPC'`.
- **Then:** extension_ui_request has title Which?; the client returns option b under the request id; the tool result received by the model contains b and not Cancelled; RPC closes cleanly; headless refusal never represents approval.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-21.log`, then use common cleanup.

#### TC-22 Exhausted report delivery retries do not lose or duplicate work

- **Covers / priority:** F4, P0, integration; `orchestration-recovery.test.ts:23,55`. **Given:** common setup plus fake timers and a sender that rejects until a subsequent settled turn.
- **When:** `ntest test/octocode/orchestration-recovery.test.ts -t 'note a resumed session|report sends after'`.
- **Then:** exhausted delivery warns once without sending; after recovery one triggerTurn delivery clears pendingIds; an active retry is left alone; restart notes name lost background children once and omit running or already-reported children.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-22.log`, then use common cleanup.

#### TC-23 ACP crashes retain evidence without replaying prompts

- **Covers / priority:** F16, P0, integration; `external-acp-reliability.test.ts:37,47`. **Given:** common setup plus POSIX, official-SDK local ACP agent/proxy fixtures and a fresh saved session; no installed vendor agent is launched.
- **When:** `ntest test/octocode/external-acp-reliability.test.ts -t 'requires explicit live or fixture|retains streamed failure evidence'`.
- **Then:** no arguments/--help make no calls; all three abrupt owned-process failures retain the existing streamed evidence and saved marker/counter; resumed prompts recover RANDOM_MARKER:14; failed prompts are not automatically replayed; owned backends close.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-23.log`, then use common cleanup.

#### TC-24 File writes verify actual bytes and refuse stale context

- **Covers / priority:** F1, P0, integration; `file-hardening.test.ts:31,124`. **Given:** common setup plus the rename fault-injection fixture and a peer editing a previously read file.
- **When:** `ntest test/octocode/file-hardening.test.ts -t 'a write is checked on disk|changed-on-disk refusal'`.
- **Then:** correct bytes persist; a post-rename mismatch or missing file returns an error requiring inspection and a fresh read; a stale write/edit is refused with the recorded peer/tool; no stale guessed edit silently succeeds.
- **Pass if / fail if:** the common oracle and every Then assertion hold; any assertion mismatch, unexpected skip, leaked owned resource or timeout fails this case.
- **Evidence to capture / cleanup:** full verbose output, exit status and any failing fixture's actual values/owned-resource evidence; retain `TC-24.log`, then use common cleanup.

## Success criteria

- [ ] All 20 P0 and all 4 P1 cases pass; zero selected cases are blocked or silently skipped. A selection that runs zero tests fails.
- [ ] Every existing selected test passes without retries, relaxed assertions, snapshot rewrites or unhandled errors; all owned-resource cleanup assertions pass.
- [ ] Each case has its command, exit status, verbose log and actual-versus-expected evidence; missing evidence is blocked.
- [ ] The pinned revision/diff and source/test contents remain unchanged, including pre-existing user changes. Only the results document and identified scratch/build artifacts may be added.
- [ ] G1 and G2 have explicit regression evidence before claiming complete agentic P0 coverage. Until then, report the 24-case result separately and retain Draft status.
- [ ] If implementation changes are made after this plan, complete the repository gates and full e2e after that wave; focused cases do not replace them. This documentation update itself runs no suites.

## Not tested

Paid model quality, live vendor ACP agents, authenticated GitHub/registry operations, public search, visible browser/clipboard/upload actions, live user sessions/databases, production migration and publishing are outside the 24-case run. Loopback web/MCP/ACP fixtures are in scope. Windows process-group behavior and desktop terminal/browser interactions need their own executor/environment. Full role-by-role memory/backlog/tool capability matrices beyond the selected fixtures are not claimed covered. The reference checks below remain separate work, not evidence that these cases passed.

## Gaps

| ID | Priority | Evidence / limitation | Required closure |
| --- | --- | --- | --- |
| G1 | P0 | Earlier wait-accounting audit, `.octocode/REFLECT.md:21`, records identity-accounting failures; this planning pass did not reproduce or close B72. TC-06/14 cover existing guards, not the entire event-order matrix. | Add/identify deterministic coverage for a repeating wake retaining its active wait, successful cancel clearing that timer, unrelated job notices not consuming a peer-reply wait, duplicate completion not decrementing twice, and one child's completion not clearing another's wait. Record exact new commands before promotion to Ready. |
| G2 | P0 | The same audit leaves direct async cancellation/shutdown races with B74. A passing process-exit case does not prove every admission/disposal interleaving. | Cover abort before launch/listener attachment, shutdown during queued admission, completion racing stop, and late async completion after disposal; assert no new process/lease/timer, duplicate report or dead-context callback. Supply runnable regression targets; source/test changes are a separate implementation task. |
| G3 | P1 | Planner runtime was Node 26.4.0; required validation runtime is Node 24.15+ within Node 24. | Execute under Node 24. No Node 26 listing result establishes runtime compatibility. |
| G4 | P1 | File discovery was checked with `vitest list --filesOnly` for 17 native and 10 e2e targets; 24 case commands and filters were read from source. No cases, build or full checks were executed. | Record real pass/fail evidence. The full e2e includes optional GitHub/registry calls (`packages/coding-agent/test/octocode/e2e-all-tools.test.ts:26`); separately record its network configuration/results rather than claiming the entire suite is offline. |
| G5 | P2 | Prior performance numbers, defect notes and untracked driver paths below were retained from the earlier plan, not remeasured/revalidated. | Confirm workload, loaded artifact, target environment and evidence before using them as release conclusions. |
| G6 | P1 | Concurrent edits changed collection/spend processing and test isolation, including new untracked helpers. Deciding isolation spans were read (`vitest.tmp.global.ts:26`, `test-isolation.ts:74`); agent tool/test targets remained available. Final verification found another fingerprint change, so the review checkpoint is already stale. | Preserve all concurrent work. Once that work settles, review the delta, rerun target discovery and replace the checkpoint fingerprint before running cases. The new collection/spend internals require their owning tests in the repository regression gate; this plan does not certify their performance. |

## Results format

Save `TEST_PLAN-results.md`; include revision, dirty diff digest, runtime/platform, start/end source-state comparison and log directory, then:

| ID | Result | Evidence | Notes |
| --- | --- | --- | --- |
| TC-01–TC-24, one row each | pass / fail / blocked | Exact command, exit status, log path and relevant assertions | Actual vs expected; reason for a block |

Evaluate every Success criteria checkbox and every G1–G6 entry. Report failed, blocked and unexecuted reference gates explicitly; no execution verdict follows from this plan's case inventory.

## Reference checks retained from the earlier plan

These retain the broader Octocode and cross-agent checklist. Historical measurements are unverified planning inputs, not results of this update; auxiliary drivers are not guaranteed available.

### Part A — Octocode baseline

Use isolated homes/config/database paths; never test the real home. Run supported Node 24, serialize builds and timed runs, snapshot the old bundle before rebuilding, retain failures and skipped checks, and use paid models only when explicitly authorized.

| Gate | Command / action | Pass / evidence |
| --- | --- | --- |
| Static checks | `yarn run check` | All configured checks pass; no rewrites. |
| Offline build | `yarn run build:offline`, then `node packages/coding-agent/dist/bundle/cli.js --version` | Build exits 0 and bundled CLI prints its version. |
| Whole repository | `./test.sh` | Exit 0 and zero unhandled errors in every workspace; inspect default → native → e2e summaries individually. |
| Focused/full sessions | `yarn run test:changed`; `yarn workspace @octocodeai/octocodecode run test:e2e` | Changed tests support iteration; full e2e remains required after an implementation wave. |
| Other owners | `yarn workspace @octocodeai/octocodecode run test:tmux`; `yarn workspace @octocodeai/octocodecode run test:architecture`; `yarn workspace @octocodeai/octocode-tui test`; `yarn workspace @octocodeai/octocode-db test` | Every selected owner suite passes; record unavailable terminal environments. |
| Prompts | `yarn workspace @octocodeai/octocodecode run generate:prompts`; inspect `.octocode/tmp/agent-prompts/`; e2e `e2e-agent-context`, `cache-edge-harness.test.ts` | Own text ≤ OWN_PREFIX_CEILING; external MCP text is reported without a cap; role tool arrays/base prefixes are byte-identical. Read exact prompts after tool/prompt/preset changes. |
| Model comprehension | `node scripts/agent-eval/run.mjs --dry-run --model <id>`; live only when explicitly requested | Deferred exposure within 2 points of direct; historical score 177 vs 178 of 186. Dry-run only plans the eval. |
| Release | `yarn run publish:dry`, then owner-authorized `yarn run publish` | Tarball installs and completes a real session; publishing is outside this plan's execution authorization. |

Historical full-run note (2026-11-12): check 11/11, build okay, every workspace green; coding-agent default 660 files / 5,012 tests, zero errors after the stale-context fix. This claim was inherited, not rerun here.

### Part A — Performance and terminal reference

Use the bundled artifact, a scripted local model, tmux at 160×45, ≥3 runs and medians/ranges. Interleave BEFORE/AFTER; load average >4 makes differences below 100 ms noise. Untraced runs establish timing; tracing adds an estimated 10–25% overhead.

| Path | Target | Historical value / limitation |
| --- | --- | --- |
| Startup / input | First paint ≤600 ms warm / 1 s cold; Enter accepted ≤1 s; first-paint key read ≤50 ms | 490 / 818 ms; Enter 911 ms but early Enter refused; input 108–122 ms, open. |
| Turn / streaming / tools | Prompt→request ≤100 ms first /30 ms later; first byte→paint ≤20 ms; tool result→request ≤30 ms | 81 /16 ms; 8–12 ms; 14 ms. |
| Compaction / resume | Visible elapsed/tokens and capped summary; 19 MB resume ≤1.2 s | Summary cap 32,768 tokens; resume 1,002 ms. |
| Switch / quit | /new ≤250 ms; resume picker ≤300 ms; selection→paint ≤700 ms; quit ≤200 ms | 174 /226 /610 /140 ms. |
| Idle / DB contention | 60 s idle CPU ≤0.5%, zero frames; write-lock event-loop delay max <20 ms | 0.1%, zero frames; 15.6 ms. |
| Subagents | Spawn→first request ≤800 ms; first done→parent wake ≤200 ms | 697 ms; wake 1,019 ms with 3 children, open. |
| Terminal interaction | One notch moves 3 lines or configured value; 240-event flick advances without jump-back; pointer-frame starts ≥16.7 ms apart; spinner still during scroll | Historical flick about 700 rows. Test output streaming, focus changes, resize, Ctrl+Z/fg and 40 rapid resizes; input ≤50 ms after the last resize. |
| Output / exit | 2 MB output renders kept preview only; completion only after !; double Ctrl+C restores terminal within 300 ms | Test Terminal.app, iTerm2, VS Code, Ghostty/kitty and tmux; Ctrl+Z must leave child/bash/background work running. |

Auxiliary untracked drivers: `.octocode/tmp/perf/waits/tools/` and `.octocode/tmp/perf/waits2/tools/` (`mkenv.sh`, `drive.py`, `mock-llm.mjs`, `wait-tracer.mjs`); `BUNDLE=<path>` selects an artifact and `OCTOCODE_TIMING=1` prints phases. Verify these inputs before use. Preserve loaded-artifact identity and the old bundle; a source diff alone is not a timing baseline.

### Part A — Storage, process and earlier findings

| Check | Procedure / oracle |
| --- | --- |
| Process audit | No owned survivors after each scenario (historical 0 in 127 runs); parent-kill and ACP fixture recovery are TC-07/23. Search all callers of processMatch/groupMembers/descendantPids/stopTree, including .mjs, for awaited async results; typecheck alone misses scripts. |
| Migration guards / real data | A live file must be refused with owning pids. Real-data migration is owner-run only after all Octocode processes close: backup, schema 10, no transcript tables in workspaces.db and no temp-workspace rows were earlier acceptance criteria; verify current schema before execution. |
| WAL / isolation | After a long reader, writes and idle, both WALs return to ≤1,000 pages; old mirror tables are absent from coordination queries; a test resolving real-home DB fails the suite. |
| Earlier open findings | Revalidate report batching/stagger timers, awaited ps sampling, MCP restarts on /new or /resume, early Enter refusal, post-paint fsync/discovery/grammar loading, and db-migrate unknown-flag/--help behavior. The old plan called these defects; this update does not establish their present status. |

### Part B — Any coding agent

Compare Octocode, Claude Code, Codex, opencode, Gemini CLI or others only on the same machine, terminal, model and scripted traffic. Each agent needs a fresh home/config, no real credentials, a loopback model with fixed first-token delay/token rate/tool script, a fixed-size tmux/pty driver polling ≤10 ms, process-tree snapshots and ≥3 interleaved runs with medians/ranges.

| Area | Workload / measurable oracle |
| --- | --- |
| Correctness / safety | Byte-exact apply/undo/conflicts across small repos, monorepos, binary, CRLF and non-UTF-8 files; mode × read/write/shell/network/MCP decisions match the mode's documented contract; injected file/tool instructions cause no unrequested action; secret fixtures never appear unredacted. |
| Cancellation / recovery | Cancel during stream/tool/child/compaction within 1 s, save state and accept the next prompt; kill mid-turn then resume with no duplicate/lost records or replayed effects; concurrent sessions/worktrees preserve shared state without UI-blocking locks. |
| Performance / scale | Measure startup→paint→accepted input, key echo idle/streaming/tools, prompt/request/tool overhead, streaming at 60 and 1,000 tok/s, scroll frame gaps, 2 MB tool output, 10k-line reads, 1/10/100 MB sessions, child spawn/report/cleanup, 60 s idle, exit survivors, writes/WAL/fsync. Use event-loop histograms, CPU profiles, syscall/process and network-phase logs where available. Declare a target per agent; no >10% regression (or >100 ms on a loaded machine) against its previous release. |
| Terminal compatibility | Terminal.app, iTerm2, VS Code, Windows Terminal, Ghostty/kitty, tmux, screen and SSH: color, wide/combining text, mouse/wheel, paste, synchronized output/fallback, resize storms, suspend/resume and restored alternate screen on every exit. |
| Model behavior | Fixed tasks with test/diff oracles; valid file/line grounding; tool calls/failures/retries/independent concurrency; prompt tokens/cache/fact retention; useful delegation without duplicated work; tokens and money per success. Paid runs require explicit authorization, ≥3 repetitions and spread. |
| Report | Agent/version, machine, terminal, model/script, median, range, run count, target, pass/fail and raw trace link for each area. Name missing coverage and why. |
