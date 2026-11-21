---
name: octocode-code-review
description: "Use to review a diff, commit, branch, uncommitted edits, a subagent worktree before merge, or finished work against its request: evidenced findings on code, tests, docs; verdict Ready, Changes required or Verification incomplete."
---

# Code review

Verify that the work does what was asked, is wired in, and is validated. Report actionable findings backed by evidence; review code, tests, comments and docs together. Never invent issues to fill a checklist or demand perfection before accepting a sound improvement. Skip the review when the reply is final and the work unchanged, unless asked to revisit it or given new evidence.

## 1. Pick the scope

| Request                                                            | Compare against                                                                                                                             | Read                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Diff, commit, branch, staged or uncommitted edits ("review this")  | the correct base: `git diff <base>...<head>`, `git diff --staged`, `git diff` plus `git status --short` for untracked files                 | changed behavior and the callers, tests and docs around it; separate regressions from pre-existing problems                                                                                |
| A subagent's or worktree's work, before merging it                 | the base it started from: `git diff <base>..refs/octocode/<id>` for an isolated child whose worktree is gone, else `git -C <worktree> diff` | every hunk, plus how it joins the code it lands in; with peers editing, review current files and name unfinished changes                                                                   |
| Final check before reporting a task done                           | the user's current requirements, corrections and scope changes                                                                              | all task changes, untracked files too; reuse valid checks, rerun them when later edits, failures or open risks make them stale                                                             |
| Everything an agent built, or work against a request, plan or spec | the requirements                                                                                                                            | the whole feature, not the last commit: map requirement → implementation → integration → verification and trace main flows through their real entry points; stay inside the requested work |

## 2. Establish the source of truth

Read the requirements and acceptance criteria, repository instructions (AGENTS.md, contribution guides), design decisions and earlier review threads, the code, tests, configuration and public interfaces, build scripts, manifests and CI, and who owns generated files and releases. Use the project's own conventions, tooling, branch strategy and approval rules.

Agent summaries and author explanations are claims to verify. A file existing does not prove it is connected; a passing command does not prove every requirement is met.

## 3. Check and validate

Read [the checklist](references/checklist.md) for the areas that matter to this change (one table row per area) and for how to validate a candidate finding: trigger, mechanism, impact, evidence, resolution, and the challenges to run against it. Validate every finding there before writing it.

Run checks with the repository's own commands, and keep apart: checks run in this review, earlier checks on unchanged code, observed CI, author-reported checks, and checks not run. Never claim execution, coverage or success without evidence.

## 4. Write findings

One independent issue per finding, no duplicates for one root cause, adapted to the output the user asked for:

```markdown
### [Priority] Short title naming the consequence

Location: file and smallest useful line range, or requirement and integration boundary for missing work.
When <trigger>, <behavior> occurs because <mechanism>. This causes <impact> or violates <contract>.
Resolve by <focused correction or needed clarification>. Verify with <scenario and expected result>.
```

Label each as defect (supported wrong behavior), question (missing context), suggestion (optional improvement) or nit (minor preference). Use the project's or your profile's severity scale (it wins over this one), else P0 immediate, broad critical failure; P1 serious correctness, security, data-loss or availability issue; P2 substantive defect in a concrete supported scenario; P3 lower-impact actionable issue. Severity is not confidence: never inflate it to make up for weak evidence. Say why a change is needed, not only what to write instead; critique the code, not the author, directly and respectfully.

## 5. Fixes and re-review

A review-only request changes no code. Inside an authorized implementation task, fix supported in-scope defects before declaring completion, then review the affected changes and rerun the relevant checks; no unrelated cleanup. When new evidence arrives, revise or withdraw disproved findings, verify fixes on the current revision, check nearby behavior and success cases, and never carry an old approval across meaningful changes. Self-review is not independent review; a second reviewer helps for consequential uncertainty but is not required.

## 6. Report

For a diff, worktree or whole-implementation review: findings by impact, open questions and verification gaps, the reviewed scope with concise validation evidence, then the readiness verdict. For a final task check, fold the result into the completion reply (what changed, what was verified, what is left) without the checklist.

| Verdict                 | When                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Ready                   | the requested behavior is implemented, no blocking finding remains, applicable validation passed |
| Changes required        | a supported defect or missing requirement blocks acceptance                                      |
| Verification incomplete | material evidence is missing, so readiness cannot be established                                 |

A requested PR recommendation maps to APPROVE, REQUEST_CHANGES or COMMENT. Verdicts are recommendations, never permission to post a review, merge, deploy or contact contributors. With no actionable findings, say so plainly, without implying a bounded review proves the whole system correct.

Done when the requested scope is checked, every finding is supported, and the verdict matches the evidence.
