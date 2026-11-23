---
name: octocode-local-research
description: "Use to trace code across this checkout with LSP: every caller or use, blast radius, a type, or proof a symbol is unused. Not for one search or read."
---

# Local research

The research server's `<mcps>` block routes each question to its tool and says how to page and cite; this skill adds the checks for tracing code with `lspSearch` and proving a claim about it. Name the question and the evidence that settles it, then take the cheapest call that can change the answer.

## Read reliably

Check that a `block` closed where the declaration ends. Search hits on very long lines show a window and `column`: re-read the whole line with the same `matchString` before relying on it. When a read falls back or reports the file too large, read by `ranges` instead of assuming a missing outline means absence.

## Drill down with `lspSearch`

Start from a `symbolName` and `line` a search returned (`occurrence` when the name repeats on that line). The first call per language may take seconds while the server starts.

1. `definition` locates the declaration (into `node_modules` for imports); `hover` gives the inferred type; `diagnostic` shows errors a change introduced.
2. `references` with `view: files` sizes the blast radius first; read content only for the files that matter. `callers` / `callees` (raise `depth` for chains) answer who calls what; they cover calls, `references` covers every use. `implementation`, `subtypes`, `supertypes` for hierarchies.
3. `workspaceSymbol` takes `symbolFuzzy` and a `path`; its results are partial, so confirm them with `localSearch`.

Check each row's `lsp` field: `syntax` or `text` level, `recovered*` rows or `analysisContext` errors mean the server did not answer, so an empty result is not absence. `workspaceRoot` widens a project the server inferred too narrowly. Code fetched from GitHub gets no language server: use text and AST there.

## Prove, then answer

A hit is a lead; read the deciding span and cite `path:line`. Finish every page before you claim completeness or "no other callers"; a partial result and skipped paths limit the claim. Absence needs an unfiltered scan (`includeHidden`, `includeIgnored`, `defaultExcludes: false`). Before deleting an "unused" symbol also check registration, exports, tests, config and docs. Say which scope you did not scan.
