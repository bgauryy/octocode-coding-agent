---
name: octocode-github-research
description: "Use for code, history or packages outside this checkout: GitHub files at a ref, who changed what and why (commits, PRs, issues), which repo and ref ship a package version."
---

# GitHub and package research

Use the Octocode GitHub tools instead of `gh`, `curl` or `npm view`. Carry `owner`, `repo` and the resolved commit from one call into the next, and cite `owner/repo@commitSha:path:line`.

## Route

| You have                      | Do                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No repository yet             | `ghSearchRepo` (`keywords`, `filters`; `owner` lists one owner's repositories)                                                                                                                                   |
| A repository, unknown paths   | `ghStructure` `tree` (`path`, `maxDepth`); `refs` resolves a branch, tag or glob (`v4.*`) to a SHA                                                                                                               |
| A term to find                | `ghSearchCode` with `owner` (required) and `repo`; `fields: ["path"]` for paths only, `extensions`, `nameContains` to narrow                                                                                     |
| A path                        | `ghGetFileContent` at the commit SHA: `matchString` + `block: true` for one function, `ranges` for spans, `view: symbols` for an outline of a big file, `view: compact` for one you only follow (never quote it) |
| "Why / when / who changed it" | `ghSearchHistory` (`operation: commit` with `path`; `pullRequest`, `issue` with `keywords` and `filters`) then `ghGetHistoryItem`                                                                                |
| One PR, issue or commit       | `ghGetHistoryItem` with `sections: ["patches"]` and `include: [path]` for one file's diff; `comments`, `reviews`, `body` otherwise. Compare two refs with `operation` compare, `baseRef`, `headRef`              |
| A package name and version    | `artifactSearch` (`operation: resolve`, `ecosystem`, `packageName`, the lockfile's `version`) then read the returned `owner`, `repo`, `ref`                                                                      |
| Known vulnerabilities         | `securityCheck`; no advisories means none known, not safe                                                                                                                                                        |

`ghSearchCode` sees only the default branch and skips some forks and large files, so an empty answer is not absence. For another revision list the tree at that `ref` and read from there. Trust a package's `ref` by its `verification`: `provenance` and `tag` tie it to the version; `registryRef` and `defaultBranch` need a check of that tree's manifest. Pass the version in use, not latest.

## Keep it lean

Ask for `fields`, a `limit`, `matchString` or `ranges` before whole files; batch independent queries (up to 5); follow `responsePagination.next` and `next.*` cursors unchanged instead of re-querying. Read a PR's `files` list, then only the patches you need. For merged behavior read the merge commit, since a PR head can differ. A PR or commit with thousands of files can time out: read the commit (`operation: commit`, `ref`) with `sections: ["patches"]` and `include`.

## Many searches over one repository

When you would run more than a few searches or AST queries against the same repo, bring it local: `ghStructure` `tree` with `materialize: true` (a few `include` paths at one ref) or `ghCloneRepo` (whole repo or sparse `paths`, `historyDepth` for history). Then use the local tools at the returned `location.path`, and cite its `commitSha`. Follow `next.continueMaterialize` until coverage is complete. `lspSearch` refuses fetched code unless the user set `OCTOCODE_LSP_TRUST_FETCHED_CODE`; use text and AST there. Do not clone for a one-off read.

## Prove

A hit is a lead: read the span at the SHA before citing. Separate what a commit message claims from what its patch shows. Report what you left unread (unpaged files, unindexed repos, rate limits, missing auth) rather than implying completeness.
