# Agent communication audit — 2026-10-29

**Assessment: 6/10 overall.** The delivery and lifecycle code is substantially stronger than the control of handoff content, cumulative spending and cross-coordinator ownership. One reproduced correctness defect can send an obsolete report to the next worker. Passing transport tests do not establish that the information being transported is current or economical.

Reviewed the working tree based on `5fda3cc084a01a755fcc68e6f13adea9ded41356`, including pre-existing staged changes. This audit changes no product source. Ratings are engineering judgments, not benchmark scores.

| Area | Rating | Basis |
| --- | --- | --- |
| Delivery and lifecycle | 8/10 | Persistent mail, context acknowledgements, dead letters, cancellation, report recovery and bounded normal inbox batches |
| Parent/worker ownership | 7/10 | Clear launch, interrupt and resume ownership; continuation instructions overpromise |
| Cross-coordinator coordination | 6/10 | Live repository-wide addressing works; task ownership and handoff agreements remain informal |
| Tool contracts and schemas | 6/10 | One public agent tool and runtime validation; published mode/input schema permits invalid combinations |
| Instructions and composition | 7/10 | Central policy, small role files and one report contract; stale mechanics and lifecycle wording remain |
| Token efficiency | 5/10 | Cache-aware prefix design and batching; large default schemas and reference expansion |
| Quality measurement | 6/10 | Usage, cache and outcomes recorded; no accepted-result cost or communication-overhead attribution |

## Actual hierarchy and reach

Native execution is a coordinator with worker children. A worker has communication and coordination modes but cannot launch another worker or use the external-agent mode. See [registration](../packages/coding-agent/src/octocode/index.ts).

| Relationship | Current behavior |
| --- | --- |
| Coordinator → own live worker | Message, steer; interrupt only its own child. Background stop is available through coordinate. |
| Worker → parent | `to: "parent"`; a question with `replyRequired: true` can wake an idle parent. A foreground parent cannot process the child's question through another model step until the foreground tool returns. |
| Live siblings | Direct messages. `collaborate: true` adds the teammate roster to task text; it does not create a messaging permission boundary. |
| Coordinator → other coordinator, same repository | Direct live ID or unambiguous role; `coordinate list` includes repository teammates. Both sessions must have joined. |
| Worker → other coordinator or its live worker, same repository | Direct live addressing works; the message is peer data, without the recipient's parent steering authority. It cannot interrupt the other tree's worker. |
| Broadcast `to: "all"` | Restricted to the sender's live session tree, excluding itself. It is not a repository broadcast. |
| Worker → finished sibling | Relay through its own parent's process, subject to saved address, capacity, spawn permission and wake eligibility. FYIs do not revive a finished sibling. |
| Worker/coordinator → finished worker of another parent | No automatic cross-parent revival. Contact the owning coordinator to arrange continuation. |
| Different repository or external host | Separate external-agent/local API/ACP path. Native children do not expose external mode. |

Owners: [routing](../packages/coding-agent/src/octocode/team/routing.ts), [send](../packages/coding-agent/src/octocode/team/session/send.ts), [relay](../packages/coding-agent/src/octocode/team/relay.ts), [lingering workers](../packages/coding-agent/src/octocode/subagents/linger.ts), [team scope](../packages/coding-agent/src/octocode/team/store/workspace.ts). The existing [communication guide](AGENT_COMMUNICATION.md) owns the ongoing feature description.

## Findings, ordered by impact

### 1. High: a resumed worker's obsolete disk report can replace its latest answer

**Reproduced under Node 24.22.1.** First run: a long `partial` report creates `report.md`. Second run, same worker/scratch: a short `done` answer withdraws the earlier conclusion. The latest transcript text is correct. Resolving `report:worker` nevertheless returns the earlier disk text, with a heading saying the worker reported `done`.

Observed result:

```text
latest transcript: done: NEW FINDING; previous conclusion withdrawn
reference heading: ... reported done ...
reference body:    partial: OLD FINDING
```

Each process run creates a new `ReportTracker`. Its small final answer does not replace an existing large-report file. `childFiles` discovers any existing `report.md`, and reference resolution prefers that file over the current transcript answer. The source chain is [new tracker](../packages/coding-agent/src/octocode/subagents/process/run-child.ts) at line 107, [conditional report write](../packages/coding-agent/src/octocode/subagents/report.ts) at line 238, [file discovery](../packages/coding-agent/src/octocode/shared/session-children.ts) at line 30, and [file-first resolution](../packages/coding-agent/src/octocode/shared/references.ts) at line 123.

Repair: bind report artifacts to `runId`/report version and persist that binding in result details. Resolve the artifact associated with the selected result; retain old artifacts as history. Do not decide freshness from filename existence or modification time alone. Add a regression covering long first report → short resumed correction, including both task resume and message resume.

### 2. High efficiency risk: report references inflate into unbudgeted inline context

**Reproduced:** six synthetic long report references expanded into **385,767 characters**, including framing. Each reference is capped at 64,000 characters, but native task expansion has no aggregate count or context budget. Resolution reads a whole report file before applying that cap.

This preserves provenance and avoids model retyping, but every receiving model still receives the expanded text. A compact-looking task can therefore contain a large amount of hidden input. Multiple repeated handoffs amplify it. The 8 KB report preview and 32 KB normal inbox batch do not constrain this separate path.

Owners: [reference expansion](../packages/coding-agent/src/octocode/shared/references.ts) at lines 57 and 163; [task insertion](../packages/coding-agent/src/octocode/subagents/task-text.ts); [whole-file reader](../packages/coding-agent/src/octocode/shared/session-children.ts). External prompts have a 20-reference count limit, but that also does not establish an aggregate token budget.

Repair: resolve references to a small summary, immutable version/hash and readable artifact location by default. Support explicit bounded excerpts. Enforce an aggregate handoff budget before launch and expose the expansion size to the coordinator. A lean worker can read a permitted artifact with its file/shell capability; it does not require automatic inclusion of the entire report.

### 3. Medium: the published tool schema and runtime disagree

**Reproduced:** `{ "type": "task", "input": { "to": "worker", "message": "FYI" } }` passes the unified tool's published schema, then fails runtime validation with `Invalid agent task input`.

The `type` enum and `input.anyOf` are independent. The schema permits the input of any operation with every operation name. Runtime validation correctly stops execution; the defect is an avoidable model/tool correction round trip, not an authorization bypass.

Owner: [agent tool assembly](../packages/coding-agent/src/octocode/agent-tool.ts) at lines 40, 42 and 56.

Repair: generate a discriminated envelope that binds each mode to its input schema, retaining runtime validation. Check the emitted schema against each supported provider's actual schema subset. If a provider cannot express that relationship, use a provider-compatible constrained representation or operation-specific declarations. Measure first-call success and declaration size before changing the public surface.

### 4. Medium: request limits do not bound the whole delegated task

Default limits are **6 concurrent workers per parent**, **160 assistant replies before steering**, and **240 before a hard stop** when the reply continues with tools. A resumed run gets a new counter. Compaction summaries are accounted for in usage but are not counted as assistant requests by this guard.

Six continuing runs can reach 1,440 replies before these hard stops, with further runs receiving new budgets. This is a ceiling illustration, not observed spending. The relay's three revivals per ten minutes guards one revival route; it is not a lifetime task budget or a cross-parent shared budget. Inactivity watchdogs exist, but they are not total spend limits.

Owners: [slots](../packages/coding-agent/src/octocode/subagents/claim.ts), [request budget](../packages/coding-agent/src/octocode/subagents/budget.ts), [per-run instantiation](../packages/coding-agent/src/octocode/subagents/process/run-child.ts) at line 151, [relay limiter](../packages/coding-agent/src/octocode/team/relay.ts).

Repair: retain the request runaway guard and add cumulative task-level limits across resumptions: model requests, actual input/output usage, estimated cost when priced, and elapsed work. Let a coordinator allocate bounded child budgets and reclaim unused allowance. Do not choose a universal smaller request limit without workload evaluation.

### 5. Medium: report instructions promise a continuation that may not exist

Every child's report contract says that its parent's reply continues the conversation after `blocked`. Automatic message continuation is enabled only for a background, non-isolated run. A foreground blocked worker instead needs an explicit task resume; an isolated worker needs an integration/recovery path. Conversely, a configured linger window can keep a `done` worker resumable despite the contract's blanket ending language.

Owners: [report contract](../packages/coding-agent/src/octocode/instructions/report.ts) at line 29, [eligibility](../packages/coding-agent/src/octocode/subagents/tool.ts) at line 332, [continuation](../packages/coding-agent/src/octocode/subagents/linger.ts).

Repair: put actual continuation capabilities and expiry in the task/result metadata. State blocked recovery conditionally. Preserve the machine-consumed `done`, `partial`, `blocked`, `failed` outcomes.

### 6. Medium design gap: cross-parent ownership is mostly a social contract

Live ID and role resolution is repository-wide; role addressing does not prefer the sender's tree. An unambiguous `reviewer` can therefore belong to a different coordinator. This is supported addressing, not a proven misdelivery. It needs explicit scope and owner information to be predictable in a busy repository.

The `collaborate` flag only adds task context. `coordinate list` provides a roster and reservations, not a dependency scheduler or shared acceptance contract. Similar-goal detection is a word-overlap advisory and does not prevent duplicate investigations. File reservations help with overlapping writes, while scripts/external editors can bypass them as the tool description explicitly acknowledges.

Owners: [target resolution](../packages/coding-agent/src/octocode/team/routing.ts) at line 186, [collaboration task construction](../packages/coding-agent/src/octocode/subagents/claim.ts) at line 295, [overlap advisory](../packages/coding-agent/src/octocode/team/overlap.ts), [reservation gate](../packages/coding-agent/src/octocode/team/tools.ts).

Repair: use exact IDs for cross-parent work, expose owning coordinator and reachability, and make task ownership explicit. Add one policy sentence: peer evidence can inform work; scope changes and shared-interface decisions go through the owning coordinator. Reuse the existing backlog/task contracts for ownership and acceptance instead of adding a parallel task database.

### 7. Medium measurement gap: current statistics cannot establish coordination ROI

Per-run usage, cached reads/writes, compactions, request percentiles and outcomes exist. They do not attribute coordination input, report expansion, repeated evidence reads, wake-only turns, or cost per result accepted by the parent. A worker's `done` word and a valid JSON result establish a reported outcome and data shape, not semantic correctness.

There is also a misleading label: `firstTurnTokens` includes uncached input **and cached reads/writes**, while `/agents stats` calls it `cold start`. A fully cached first request still contributes to that label. It should read `initial context`, with cold/miss tokens measured separately. This is a presentation issue; the separate cache-rate calculation is token-weighted correctly.

Owners: [first-request measurement](../packages/coding-agent/src/octocode/subagents/tracking.ts) at line 91, [statistics](../packages/coding-agent/src/octocode/subagents/stats.ts) at line 175, [cache metrics](../packages/coding-agent/src/octocode/subagents/cache-monitor.ts), [structured result validation](../packages/coding-agent/src/octocode/subagents/result-schema.ts).

## Current context footprint

Freshly measured on this working tree using the registration/composition method of the existing prompt-size test, with isolated configuration. These are **characters**, not provider-token measurements. They include native policy, active native tool descriptions, JSON schemas and guidelines. They exclude the base system prompt, repository instructions, MCP declarations, skill catalog metadata, role text and conversation/task bodies. The child case is generic, not every specialist's actual selection.

| Component | Coordinator | Generic child |
| --- | ---: | ---: |
| Native policy and active native tools | 44,292 | 34,229 |
| Policy portion | 7,184 | 5,087 |
| Unified `agent` tool portion | 7,434 | 2,536 |
| Graph tools portion | 12,616 | 12,616 |

Graph declarations alone are approximately 28.5% of the measured coordinator surface and 36.9% of the generic child's. The biggest immediate reduction is tighter task/profile tool selection. Broad default selection makes specialist names look more selective than their tool exposure actually is. Researcher/reviewer profiles exclude some tools, so their exact footprint must be measured separately before assigning a savings estimate.

Caching work is already substantial: stable policy sections, child identity/task data after reusable instructions, sibling affinity keys, staggered cold launches, bounded mail, report batching, and separate compaction usage receipts. Preserve it. Changing tool declarations each turn can invalidate reusable prefixes; choose stable profile selections at launch. Anthropic documents the tools → system → messages cache hierarchy and distinguishes prompt-cache savings from context-window reduction ([tool caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching), [context management](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)). Exact savings remain provider/workload dependent.

## Prompt and duplication review

- Keep the existing split: tool declarations own mechanics; common policy owns judgment; role files own specialist criteria; task text owns child identity and report requirements.
- The native registration exposes one public `agent` tool. Internal `sendMessage` and `coordinate` definitions feed that tool; they are not duplicate public registrations.
- The report contract is composed once per task, and existing tests check that it is absent from shared policy. Distinct transport/report/message structures have different responsibilities; their existence alone is not duplication.
- Update stale model-visible wording such as `use coordinate` and `coordinate stop` to the actual `agent` mode syntax. Keep that wording in the owning declaration, without copying it into every role.
- Clarify the annotation-only meaning of `collaborate`. Correct the continuation contract above. Add a single ownership rule for cross-parent messages.
- Keep the existing instruction to send decision-changing evidence, blockers and questions, skip acknowledgements, and let final reports arrive automatically. It is a useful efficiency rule; copying it into each role would add noise.
- Small repetition of evidence/report expectations in role files is lower priority than the measured schema and reference costs.

## Recommended order

1. Correct versioned report selection and add the resumed-correction regression.
2. Bound total handoff expansion and default to concise summaries plus versioned artifacts.
3. Bind the operation discriminator to its input schema and correct lifecycle/tool wording.
4. Define stable, smaller specialist tool selections; preserve cache prefixes within each selection.
5. Carry cumulative budgets across worker resumes and measure parent acceptance separately from worker completion.
6. Add explicit cross-parent ownership/scope to existing contracts and measure communication overhead.

Operationally, keep one accountable coordinator per user objective. Delegate independent tasks with acceptance checks and disjoint ownership. Let workers exchange narrow evidence directly. Route decisions that change scope through their coordinators, and batch results for integration. Anthropic's multi-agent experience supports bounded delegation, explicit outputs and artifact handoffs; its reported token multipliers are observations of its workloads and are **not measurements of this repository** ([engineering account](https://www.anthropic.com/engineering/multi-agent-research-system)).

## Verification and limits

- Node **24.22.1**, Yarn **4.18.1**, Vitest **4.1.12**.
- Focused source-backed suite: **25 files, 257 tests passed**, 23.90 seconds. It covers delivery, context acknowledgement, interruption, forwarding, references, report tracking, request budgets, sibling staggering, cache metrics, result schemas and instruction composition.
- Separate owner-function reproductions confirmed stale report resolution, 385,767-character expansion and schema/runtime disagreement. The reference-size fixture uses synthetic long reports; it is not production traffic.
- Fresh native-surface measurement produced the table above. Existing historical measurements in test comments were not reused as new results.
- Additional process/lifecycle suite: **8 files, 47 tests passed and 2 failed**, 92.19 seconds. A 20-process simultaneous-join test timed out at its unchanged 30-second limit, and a PID-reuse test retained a row it expected to retire.
- Isolated rerun of the process file: **9 passed, 1 failed**, 5.07 seconds. The simultaneous-join case passed without changing its assertions or timeout. The PID-reuse check still failed: this environment denies `ps`; the process identity owner explicitly treats an unreadable start time as unknown and retains a live PID's ownership. This does not validate PID-reuse detection on an unrestricted host. The first timeout was not reproduced in isolation; its exact cause remains unproven.
- Across the 33 distinct selected files, **305 of 306 distinct tests passed on their latest execution**; one environment-limited check remains failed. No coverage thresholds or assertions were changed.
- The separate routing probe confirmed live cross-tree ID/role delivery, tree-only broadcast and refusal of a cross-tree interrupt. All local Markdown targets in the review were checked for existence.
- No live LLM/provider-cost benchmark, external ACP peer, browser, or full-repository test/build was run. This audit cannot certify all transports or actual user-workload savings.
- Existing changes were preserved. Only this review and reproducible audit material under `.octocode/tmp/` were added.

Local evidence: [suite log](../.octocode/tmp/agent-communication-audit-20261029.log), [lifecycle log](../.octocode/tmp/agent-communication-lifecycle-audit-20261029.log), [isolated process rerun](../.octocode/tmp/agent-communication-multiprocess-isolated-20261029.log), [reproduction script](../.octocode/tmp/agent-communication-audit-repro.ts), [reproduction output](../.octocode/tmp/agent-communication-audit-repro-20261029.log), [measurement script](../.octocode/tmp/agent-communication-audit-size.ts), [measurement output](../.octocode/tmp/agent-communication-audit-size-20261029.log). Scratch logs are reproducible and may be cleaned later; the dated measurements and findings above remain the review record.
