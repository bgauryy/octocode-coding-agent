---
name: octocode-local-research
description: "Use before searching or reading code in this checkout: where it is defined, how it works, who calls it, what a change affects, its type. Search, minimal reads, LSP drill-downs. Not GitHub or packages (octocode-github-research) or runtime failures (octocode-debugging)."
---

# Local research

Research this checkout with `structureSearch`, `localSearch`, `astSearch`, `localFetch` and `lspSearch`; `bash` is for running things. Name the question and the evidence that settles it, then take the cheapest call that can change the answer. A known path or line goes straight to `localFetch`. Batch independent queries in one call (up to 5), give each a `mainGoal`, and reuse paths and lines you already observed.

## Find

| You have | Use |
| --- | --- |
| A half-known name, or "largest / newest / longest file" | `structureSearch` (`operation: files`, `nameRegex`, `sort`; `view: paths`) |
| A word, error text or option name | `localSearch`; `view: files` for which files, `countMatches` or `countLines` for exact counts (a content page's total is only a floor) |
| A code shape (calls, imports, declarations, a call inside a loop) | `astSearch` (`operation: match` with a `rule`; `symbols` with `symbolFilter` for a declaration by name); its hits are candidates |
| A symbol name and a line from any hit | `lspSearch` (below) |

Narrow with `path`, `include`, `fileHas` and `testCode: exclude` before widening. `wholeWord` for identifiers; `regexEngine` only when the pattern needs it.

## Read the least

| Need | `localFetch` |
| --- | --- |
| One function or class | `matchString` (a unique spelling) with `block: true` |
| Lines around a hit | `matchString` with `contextLines`, or `ranges: [{startLine, endLine}]` (several spans in one call) |
| The shape of a big file | `view: symbols`, then a `matchString` + `block` on the one declaration |
| Comment-heavy or minified code you only need to follow | `view: compact` (never quote it; quote from `content`) |

Check that a `block` closed where the declaration ends. Search hits on very long lines show a window and `column`: re-read the whole line with the same `matchString` before relying on it. When `viewFallback` or `fileTooLarge` appears, read by `ranges` instead of assuming a missing outline means absence.

## Drill down with `lspSearch`

Start from a `symbolName` and `line` a search returned (`occurrence` when the name repeats on that line). The first call per language may take seconds while the server starts.

1. `definition` locates the declaration (into `node_modules` for imports); `hover` gives the inferred type; `diagnostic` shows errors a change introduced.
2. `references` with `view: files` sizes the blast radius first; read content only for the files that matter. `callers` / `callees` (raise `depth` for chains) answer who calls what; they cover calls, `references` covers every use. `implementation`, `subtypes`, `supertypes` for hierarchies.
3. `workspaceSymbol` takes `symbolFuzzy` and a `path`; its results are partial, so confirm them with `localSearch`.

Check each row's `lsp` field: `syntax` or `text` level, `recovered*` rows or `analysisContext` errors mean the server did not answer, so an empty result is not absence. `workspaceRoot` widens a project the server inferred too narrowly. Code fetched from GitHub gets no language server: use text and AST there.

## Prove, then answer

A hit is a lead; read the deciding span and cite `path:line`. Search paging (`responsePagination.next`, then each row's `next.nextPage`, `hasMore`) must finish before you claim completeness or "no other callers"; `isPartial`, a `countScope` other than complete and skipped paths limit the claim. Absence needs an unfiltered scan (`includeHidden`, `includeIgnored`, `defaultExcludes: false`). Before deleting an "unused" symbol also check registration, exports, tests, config and docs. Say which scope you did not scan.

When many hits need a judgment by meaning, load octocode-clasify instead of reading them all.
