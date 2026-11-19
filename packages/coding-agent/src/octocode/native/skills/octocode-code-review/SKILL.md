---
name: octocode-code-review
description: "Use to review a diff, commit, branch, uncommitted edits, a subagent's worktree before merge, or finished work against its request. Evidenced findings on code, tests, docs; verdict Ready, Changes required or Verification incomplete."
---

# Code review

Verify that the work does what was asked, is wired in, and is validated. Report actionable findings backed by evidence; review code, tests, comments and docs together. Never invent issues to fill a checklist or demand perfection before accepting a sound improvement. Do not start because a reply is final, and do not repeat a finished review of unchanged work without new evidence or a request to revisit it.

## 1. Pick the scope

| Request | Compare against | Read |
| --- | --- | --- |
| Diff, commit, branch, staged or uncommitted edits ("review this") | the correct base: `git diff <base>...<head>`, `git diff --staged`, `git diff` plus `git status --short` for untracked files | changed behavior and the callers, tests and docs around it; separate regressions from pre-existing problems |
| A subagent's or worktree's work, before merging it | the base it started from: `git diff <base>..refs/octocode/<id>` for an isolated child whose worktree is gone, else `git -C <worktree> diff` | every hunk, plus how it joins the code it lands in; with peers editing, review current files and name unfinished changes |
| Final check before reporting a task done | the user's current requirements, corrections and scope changes | all task changes, untracked files too; reuse valid checks, rerun them when later edits, failures or open risks make them stale |
| Everything an agent built, or work against a request, plan or spec | the requirements | the whole feature, not the last commit: map requirement → implementation → integration → verification and trace main flows through their real entry points; stay inside the requested work |

## 2. Establish the source of truth

Read the requirements and acceptance criteria, repository instructions (AGENTS.md, contribution guides), design decisions and earlier review threads, the code, tests, configuration and public interfaces, build scripts, manifests and CI, and who owns generated files and releases. Use the project's own conventions, tooling, branch strategy and approval rules.

Agent summaries and author explanations are claims to verify. A file existing does not prove it is connected; a passing command does not prove every requirement is met.

## 3. Check what matters for this change

| Area | Check |
| --- | --- |
| Completeness, integration | every requested behavior exists and is reachable from its entry point; routes, exports, registrations, configuration and dependency wiring reach the consumers; migrations, build artifacts and package metadata come along; no stub, hardcoded result or mock-only path poses as the feature; parts work together across boundaries; deferred work is said, not reported done. Read the actual paths, not file names or isolated unit tests |
| Correctness | supported inputs, state transitions, invariants; follow entry → validation → state changes → effects → result; boundaries, error propagation, partial failure, cleanup, recovery; consequential effects only after required validation; callers handle absent values, exceptions and partial results |
| Compatibility | arguments, defaults, aliases, attributes, return values, exceptions, serialized and persisted data, public types and consumer inference, hooks, overrides, wrappers, sync/async/streaming and other transports, runtimes, platforms, package exports. An input alias may lose attribute access; runtime success can hide broken types; a shared helper's callers may assume different things. Apply the project's migration and deprecation policy |
| Concurrency, lifecycle | before claiming a race, state the event sequence: what starts first, what changes while it is pending, who owns the state or resource, what retry, cancellation or shutdown does. Check shared vs request-local state, stale results, single-use iterators, duplicate effects, cleanup; name the operations that establish ordering, since a reassuring comment proves nothing |
| Performance | name the workload and cost: input size, repeated work, interactive latency, allocations and retained memory, I/O, startup, bundle size, concurrency. Back a finding with a measurement or a concrete cost mechanism; no speculative micro-optimizations; an optimization must keep correctness and compatibility |
| Design | solves the present requirement; abstractions share real behavior; public options have a shown purpose; ownership is clear; app policy stays out of reusable layers; unrelated refactors do not hide the change. Name the practical cost of needless complexity; accept equally valid approaches that fit the conventions |
| Security, trust | when sensitive behavior changes: validation, authorization, credentials, file paths, network destinations, dependency and build changes. Tie a finding to a reachable scenario and a contract; separate a shown vulnerability from a hypothesis; check that legitimate consumers still work |
| Tests | would each important test fail on the original defect, hit the boundary, assert behavior rather than copied implementation, keep success cases beside negative ones, and encode the right requirement? Match validation to the change: regression tests for bugs, integration tests for wiring, consumer type checks for public types, controlled scheduling for concurrency, negative assertions for effects that must not happen, UI checks for visible behavior, benchmarks for performance claims, doc checks for contributor workflows. Prefer deterministic coordination to sleeps; inspect snapshot and baseline changes instead of accepting regenerated output; no tests for trivial changes; never weaken tests or expected results to pass |
| Comments, docstrings | comments explain what code cannot: reasoning, invariants, preconditions, ownership, ordering, compatibility limits, workarounds and when to remove them. Flag stale or misleading guarantees about validation, safety, lifetime and synchronization; prefer clearer code to explanation; no comments that repeat syntax. Docstrings give purpose and usage: arguments, defaults, results, errors, units, side effects. Keep reasoning that would otherwise live only in the review |
| Contribution docs | a contributor can follow the workflow: prerequisites, working directories, install, test, build and doc-check commands match the real scripts and configuration; generated-file notes name the source of truth; submission guidance (contribution types, venue, issue or design discussion, PR template and scope, release notes, changesets, migration notes, ownership, licensing, security reporting) is right where it applies; no real secrets or private data. Never invent policy; block only on instructions that would fail, mislead or stop a valid contribution. A PR description states the problem, resulting behavior, trade-offs and validation of the final change |

Run checks with the repository's own commands, and keep apart: checks run in this review, earlier checks on unchanged code, observed CI, author-reported checks, and checks not run. Never claim execution, coverage or success without evidence.

## 4. Validate each candidate finding

A finding needs a trigger (supported input, state or event sequence), a mechanism (the code path), an impact (what is observed), evidence (a contract, source trace, test or reproduction) and a resolution (a focused fix or a distinguishing check). Challenge it: does another layer enforce this, is the scenario supported, is the behavior intended, does it apply to this revision, is it pre-existing or already reported, would the fix break a valid case? A concrete static argument can prove a defect; say whether it is static reasoning or a reproduction. Open hypotheses stay questions; missing validation is a verification gap unless it proves a defect or breaks a required acceptance condition. For an omitted requirement, cite the requirement and the missing behavior, never an invented line.

## 5. Write findings

One independent issue per finding, no duplicates for one root cause, adapted to the output the user asked for:

```markdown
### [Priority] Short title naming the consequence
Location: file and smallest useful line range, or requirement and integration boundary for missing work.
When <trigger>, <behavior> occurs because <mechanism>. This causes <impact> or violates <contract>.
Resolve by <focused correction or needed clarification>. Verify with <scenario and expected result>.
```

Label each as defect (supported wrong behavior), question (missing context), suggestion (optional improvement) or nit (minor preference). Use the project's or your profile's severity scale, else P0 immediate, broad critical failure; P1 serious correctness, security, data-loss or availability issue; P2 substantive defect in a concrete supported scenario; P3 lower-impact actionable issue. Severity is not confidence: never inflate it to make up for weak evidence. Say why a change is needed, not only what to write instead; critique the code, not the author, directly and respectfully.

## 6. Fixes and re-review

A review-only request changes no code. Inside an authorized implementation task, fix supported in-scope defects before declaring completion, then review the affected changes and rerun the relevant checks; no unrelated cleanup. When new evidence arrives, revise or withdraw disproved findings, verify fixes on the current revision, check nearby behavior and success cases, and never carry an old approval across meaningful changes. Self-review is not independent review; a second reviewer helps for consequential uncertainty but is not required.

## 7. Report

For a diff, worktree or whole-implementation review: findings by impact, open questions and verification gaps, the reviewed scope with concise validation evidence, then the readiness verdict. For a final task check, fold the result into the completion reply (what changed, what was verified, what is left) without the checklist.

| Verdict | When |
| --- | --- |
| Ready | the requested behavior is implemented, no blocking finding remains, applicable validation passed |
| Changes required | a supported defect or missing requirement blocks acceptance |
| Verification incomplete | material evidence is missing, so readiness cannot be established |

A requested PR recommendation maps to APPROVE, REQUEST_CHANGES or COMMENT. Verdicts are recommendations, never permission to post a review, merge, deploy or contact contributors. With no actionable findings, say so plainly, without implying a bounded review proves the whole system correct.

Done when the requested scope is checked, every finding is supported, and the verdict matches the evidence.
