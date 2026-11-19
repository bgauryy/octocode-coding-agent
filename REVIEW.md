---
name: implementation-review
description: Review code, tests, code comments, and contribution documentation for correctness, completeness, compatibility, and maintainability. Trigger when reviewing a pull request or diff, before declaring a coding or implementation task complete, or when checking an agent's entire implementation against the user's requirements. Find actionable defects, verify integration and validation evidence, and report readiness with clear limits. Do not trigger for ordinary nontechnical final answers, status updates, or unrelated repository-wide cleanup.
---

# Implementation Review

Verify that the implementation fulfills the requested behavior,
integrates correctly, and has appropriate validation.

Produce actionable findings supported by evidence. Review code,
tests, comments, and documentation together. Do not invent issues
to fill a checklist or demand perfection before accepting a
sound improvement.

## When to activate

Activate for these three situations:

1. PR review:
   A user requests review of a pull request, branch, commit,
   staged changes, or diff.

2. Final task check:
   An implementation task is approaching completion and the
   agent is about to report that the work is finished.

3. Whole implementation review:
   A user asks to check everything an agent built, validate
   an implementation, or compare delivered work with a request,
   plan, specification, or acceptance criteria.

Examples:

- "Review this PR."
- "Check the changes before wrapping up."
- "Verify that the task is actually complete."
- "Review everything the agent implemented."
- "Does this implementation satisfy the original request?"

Do not activate merely because a response is final.
Do not repeat a completed review of unchanged work without
new evidence or a request to revisit it.

## Choose the review scope

### PR review

Compare the candidate with the correct base. Review changed
behavior and relevant surrounding code, callers, tests, and docs.

Prioritize defects introduced, exposed, or worsened by the change.
Separate pre-existing problems from regressions.

### Final task check

Compare the actual result with the user's current requirements,
including accepted corrections and scope changes.

Inspect all task changes, including relevant untracked files.
Check that tests, documentation, and the final completion claims
match the delivered work.

Use existing valid checks. Rerun them when subsequent changes,
failures, or unresolved risks make earlier results insufficient.

### Whole implementation review

Review the complete feature or subsystem delivered by the agent,
not just the last commit.

Build a compact requirement-to-evidence map:

Requirement → implementation → integration → verification

Trace important user flows through their actual entry points.
Check for missing requirements, disconnected components,
placeholder behavior, and unsupported completion claims.

Bound the review to the requested implementation. Do not turn
it into an unrelated audit of the entire repository.

## Establish the source of truth

Read the relevant:

- User requirements and acceptance criteria.
- Repository instructions and contribution guidelines.
- Design decisions and existing review discussions.
- Code, tests, configuration, and public interfaces.
- Build scripts, package manifests, and CI definitions.
- Generated-file ownership and release conventions.

Treat agent summaries and author explanations as claims to verify.
A file existing does not prove it is connected or usable.
A passing command does not prove every requirement is satisfied.

Use the target project's conventions. Do not impose another
project's tooling, formatting, branch strategy, or approval rules.

## Review the implementation

Apply the following checks where they matter.

### Completeness and integration

- Every requested behavior has an implementation.
- New code is reachable through the intended entry point.
- Routes, exports, registrations, configuration, and dependency
  wiring connect the implementation to its consumers.
- Required migrations, build artifacts, and package metadata
  accompany the change.
- Temporary stubs, hardcoded results, and mock-only behavior
  do not masquerade as production functionality.
- Changes work together across component boundaries.
- Deferred work is explicit and is not reported as complete.

Inspect actual paths rather than inferring integration from
filenames or isolated unit tests.

### Correctness

Identify the supported inputs, state transitions, and invariants.

Follow the relevant path:

Entry point → validation → state changes → effects → result

Check boundary cases, error propagation, partial failures,
cleanup, and recovery.

Verify that consequential effects happen only after required
validation. Check how callers handle absent values, exceptions,
and partial results.

### Compatibility

Check affected contracts, including:

- Arguments, defaults, aliases, attributes, and return values.
- Exceptions, serialized data, and persisted state.
- Public types and consumer type inference.
- Extension hooks, subclass overrides, and wrappers.
- Sync, async, streaming, and alternate transport paths.
- Supported runtimes, platforms, and package exports.

An input alias may not preserve attribute access.
Runtime success may coexist with broken public types.
A shared helper may have callers with different assumptions.

Apply the project's migration and deprecation policy when needed.

### Concurrency and lifecycle

Describe a concrete event sequence before claiming a race:

- What begins first?
- What can change while an operation is pending?
- Who owns the state or resource?
- What happens on retry, cancellation, or shutdown?

Check shared versus request-local state, stale results,
single-use iterators, duplicate effects, and resource cleanup.

For synchronization claims, identify the operations that
establish ordering. Do not accept reassuring comments as proof.

### Performance

Identify a meaningful workload and cost:

- Input size and repeated work.
- Latency during user interaction.
- Allocations and retained memory.
- I/O, startup, bundle size, and concurrency.

Support a performance finding with measurements or a concrete
cost mechanism under relevant conditions.

Do not demand speculative micro-optimizations.
Check that an optimization preserves correctness and compatibility.

### Design and maintainability

- The solution addresses the present requirement.
- Abstractions represent actual shared behavior.
- Public options have a demonstrated purpose.
- Ownership and responsibilities are understandable.
- Application-specific policy stays out of reusable layers.
- Unrelated refactors do not obscure the change.

Explain the practical cost of unnecessary complexity.
Accept equally valid approaches that fit project conventions.

### Security and trust boundaries

When the change affects sensitive behavior, inspect validation,
authorization, credentials, file paths, network destinations,
and dependency or build changes.

Tie findings to a reachable scenario and an applicable contract.
Distinguish a demonstrated vulnerability from a hypothesis.

Check successful control cases so a defensive change does not
silently break legitimate consumers.

## Review tests and validation

Determine what each important test proves.

- Would it fail for the original defect?
- Does it exercise the relevant boundary?
- Are assertions about behavior rather than copied implementation?
- Are successful cases preserved alongside negative cases?
- Does the test itself encode the correct requirement?

Select validation proportional to the change:

- Regression tests for concrete bugs.
- Integration tests for wiring and interactions.
- Consumer type checks for public typing changes.
- Controlled scheduling for concurrency.
- Negative assertions for effects that must not happen.
- UI interaction checks for visible behavior.
- Benchmarks for consequential performance claims.
- Documentation checks for changed contributor workflows.

Prefer deterministic coordination to arbitrary sleeps.
Inspect snapshot and baseline changes rather than accepting
regenerated output automatically.

Do not add tests for trivial changes when they provide no useful
evidence. Do not weaken tests or alter expected results merely
to make the implementation pass.

Use commands established by the repository.
Distinguish:

- Checks executed during this review.
- Relevant earlier checks on unchanged code.
- Observed CI results.
- Author-reported checks.
- Checks that remain unperformed.

Never claim execution, coverage, or success without evidence.

## Review code comments and docstrings

Check that comments accurately explain information future readers
cannot easily recover from the code:

- Non-obvious reasoning.
- Invariants and preconditions.
- Ownership and ordering.
- Compatibility constraints.
- Workarounds and their removal conditions.

Flag misleading or stale guarantees, especially statements about
validation, safety, lifetime, and synchronization.

Prefer clearer code when it removes the need for explanation.
Do not demand comments that merely repeat syntax.

Docstrings should describe purpose and usage, including relevant
arguments, defaults, results, errors, units, and side effects.

Preserve essential reasoning in code or documentation when it
would otherwise exist only in the review conversation.

## Review contribution documentation

When contribution docs are changed or affected, verify that a
contributor can follow the documented workflow.

Check relevant prerequisites, working directories, installation,
test commands, build steps, and documentation validation against
the repository's actual scripts and configuration.

Check generated-file instructions identify the source of truth.

Verify applicable submission guidance:

- Accepted contribution types and submission venue.
- Issue or design-discussion requirements.
- PR template and scope expectations.
- Release notes, changesets, and migration documentation.
- Ownership, licensing, and security reporting.

Keep examples free of real secrets and private data.

Do not invent project policy or treat every editorial improvement
as a blocker. Prioritize instructions that would fail, mislead,
or prevent a valid contribution.

PR descriptions should explain the concrete problem, resulting
behavior, relevant tradeoffs, and validation of the final change.

## Validate candidate findings

Before reporting a defect, establish:

1. Trigger: a supported input, state, or event sequence.
2. Mechanism: the code path that causes the problem.
3. Impact: the observable consequence.
4. Evidence: a contract, source trace, test, or reproduction.
5. Resolution: a focused correction or distinguishing check.

Challenge each candidate:

- Does another layer enforce the condition?
- Is the scenario supported?
- Is the behavior intentional?
- Does the claim apply to this revision?
- Is it pre-existing or already reported?
- Would the suggested fix break a valid case?

A concrete static argument can establish a defect without runtime
execution. Clearly distinguish static reasoning from reproduction.

Keep unresolved hypotheses as questions.
Keep missing validation as a verification gap unless it proves
a defect or violates a required acceptance condition.

For omitted requirements, point to the requirement and describe
the missing behavior. Do not invent a line location for absent code.

## Write actionable findings

Use one independent issue per finding.

Preferred shape:

### [Priority] Short title describing the consequence

Location: precise file and smallest useful line range, or
requirement and integration boundary for missing functionality.

When [trigger], [behavior] occurs because [mechanism].
This causes [impact] or violates [contract].
Resolve by [focused correction or necessary clarification].
Verify with [scenario and expected result].

Adapt the format to the user's requested output.

Avoid duplicate findings for the same root cause.
Explain why the change is needed, not just a preferred replacement.

Separate:

- Defect: supported incorrect behavior.
- Question: missing context or unresolved reasoning.
- Suggestion: useful optional improvement.
- Nit: minor preference.

Use the project's severity scale. Otherwise use:

- P0: immediate, broadly applicable critical failure.
- P1: serious correctness, security, data-loss, or availability issue.
- P2: substantive defect in a concrete supported scenario.
- P3: lower-impact actionable issue.

Confidence and severity are different.
Do not inflate severity to compensate for weak evidence.

Critique the implementation, not the author.
Be direct, respectful, and specific.

## Handle fixes and re-review

For review-only requests, report findings without modifying code.

During an already-authorized implementation task, fix supported
in-scope defects before declaring completion. Then review the
affected changes and rerun the relevant checks.

Do not expand into unrelated cleanup.

When new evidence arrives:

- Revise or withdraw disproved findings.
- Verify the fix on the current revision.
- Check nearby behavior and successful control cases.
- Do not carry an old approval across meaningful changes blindly.

Do not describe self-review as independent review.
An additional reviewer is useful for consequential uncertainty,
but this skill does not require delegation.

## Report the outcome

For a PR or whole-implementation review, report:

1. Actionable findings, ordered by impact.
2. Material open questions or verification gaps.
3. Reviewed scope and concise validation evidence.
4. Readiness conclusion.

For a final task check, incorporate the result into the normal
completion response: what changed, what was verified, and any
remaining limitation. Do not dump the entire checklist.

Use these readiness conclusions:

- Ready: requested behavior is implemented, no blocking findings
  remain, and applicable validation is satisfied.
- Changes required: a supported defect or missing requirement
  prevents acceptance.
- Verification incomplete: material evidence is missing, so
  readiness cannot yet be established.

When a PR recommendation is requested, map these to APPROVE,
REQUEST_CHANGES, or COMMENT as appropriate.

These are recommendations, not permission to publish a review,
merge, deploy, or contact contributors.

If no actionable findings remain, say so plainly.
Do not imply that a bounded review proves the entire system correct.

Stop when the requested scope has been checked, findings are
supported, and the conclusion matches the available evidence.
