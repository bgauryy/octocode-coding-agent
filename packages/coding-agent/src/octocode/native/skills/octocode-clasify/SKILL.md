---
name: octocode-clasify
description: "Use when many unread files, hits, history rows or logs need sorting by a yes/no, label or score needing no reasoning, so you read only what matters. Not when exact search answers it or for a claim you must prove."
---

# Classify instead of reading

`clasify` (and `classification` on `localSearch`, `localFetch`, `ghSearchCode`, `ghGetFileContent`, `ghSearchHistory`, `ghGetHistoryItem`, `structureSearch`) asks a model a typed question about material you have not read. It scouts; it never proves. Each `evaluate`, `sections` and fresh inline query bills the provider; a repeated `evaluate` bills again. Without a classification key the tool and the fields are absent or answer `missingConfiguration`: that is a gap, not a setting to change.

## When

Use it when the question is a determinable fact about the text (does this log show a failed login, does this function do network I/O, is this PR about the build) and the pile is too big to read. Do not use it when:

- an exact search answers it (a spelling, a count, a symbol's callers, "is this file present");
- the claim needs proof, absence or completeness: read the source;
- a few small files would be cheaper to read than the call;
- the answer needs reasoning across distant parts.

## Ask

| Type     | Question shape                                         | Reading                                                                   |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `noul`   | One observable yes/no naming the action and the object | Probability of yes; 0.5 and above counts as yes. Low is not proof of no   |
| `choice` | `criteria`: 2-255 labels, with `unknown`               | The most confident label; use `unknown` for absence, never a "none" label |
| `score`  | `criteria`: 2-10 ordered levels from 0                 | Expected level, possibly fractional                                       |

Each question stands alone: the provider sees no conversation and no sibling answers, so put the context and the near misses to exclude in the `instructions`. Several questions about one source go in one call; name the deciding mechanism, and separate implementation from declaration or reporting.

## Feed it

| You have                             | Send (`operation: evaluate`)                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| One file or page                     | `source: {tool: "localFetch", query: {path, ranges?}}`, or `ghGetFileContent`, or `{url}`                        |
| Search hits, paths, history rows     | `source: {tool, query}`; each row is a unit (`path:line` for a hit, judged with its `contextLines`)              |
| Several files, one answer each       | `resources: {name: {tool, query: {path: "glob"}}}`                                                               |
| Where in many files the answer lives | `operation: sections` with `resources` and `questions`; page with `next.nextPage` until no sections remain       |
| Command output or a log              | save it under the workspace, then `source` on that path; `sections` for every place or event order               |
| Text or an array in hand             | `content`; an array with `perItem: true` judges each item                                                        |
| Hits while you search                | `classification: {predicates: [...], context?}` on the search itself; add the `contextLines` the predicate needs |

One of `source`, `resources` or `content` per row; a path inside `content` is just text. A row-level `model` overrides the default (`operation: models` lists them); `longContext` is rarely needed. Up to 5 rows per call. Narrow with a glob or `ranges` first; that is the main cost control.

## Verify

Follow `next.read` (it opens the lines the answer named) or read the deciding span with `localFetch` or `ghGetFileContent` before you cite anything. Finish response pages first, then `next.nextCandidatePage`. Rows marked unknown, unassessed, error or excluded are not negative evidence: for an absence or a count run `next.unfilteredUnknown` and `next.unfiltered`, or an exact search. A source larger than the provider window is judged by one section, so it cannot show whole-file absence or ordering: use `sections` and read its `coverage`. Label every judgment as a model judgment in your report.
