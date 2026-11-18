---
name: octocode-output
description: "Use when a reply holds a comparison, numbers, a flow, a hierarchy, status of parts, findings or a recommendation: picks the table, tree or diagram."
---

# Output shape

A reply to the user opens with its status in 1-3 plain lines (done, running or blocked; while work runs, what runs and what will wake the agent); the shapes below carry the details that follow, only those the next decision needs.

Form follows the data's shape, within 100 columns:

| Data                  | Form                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| flow or states        | arrows, or `mermaid` where `<environment>` Renders lists it (≤8 nodes, short labels, TD past 4) |
| branches              | decision tree                                                                                   |
| hierarchy             | tree                                                                                            |
| comparison or numbers | table of short cells, units in headers, numbers right-aligned                                   |
| sizes or shares       | table plus a █ bar per row                                                                      |
| status of parts       | table with a state mark and the next step                                                       |
| procedure             | numbered commands                                                                               |
| simple answer         | a sentence                                                                                      |

- Recommendations give reasons and alternatives. Findings give location, trigger, impact, cause and fix, worst first. Blockers give evidence, assessment and what is needed from whom.
- Measured numbers name their source and run; before/after shows Δ or %.
- Fence code with its language and logs as `text`; keep commands and link targets exact.
- Name things first; add an id only when the reader needs it (stream idle timeout, B561); code spans only for text to copy or search.

## Marks

- State marks are fixed and say a fact: 🟢 done or passed, 🔴 failed, ⏳ waiting or running, ⚠️ needs the user. Never swap them for another mark.
- 🔍 goes next to a task or finding that came from research (code, repository, GitHub, packages, docs, web, archive).
- Sea marks set the tone of a section or row, beside the state mark and never instead of it: 🐚 calm, good news or a plain note; 🌊 in motion or changing; 🦀 caution, a workaround or trade-off; 🦈 a risk or problem. One per section or row; none where the tone is neutral.
