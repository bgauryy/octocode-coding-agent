# Changelog

Entries are shown once by `octocode` after an update and on demand with `/changelog`. Each heading names the package version; earlier releases predate this file.

## [Unreleased]

- Settings files with a root key Octocode does not read now produce a warning at startup, naming the key and file. A `compaction` block, which has had no effect since compaction limits became built-in, is reported with its replacement (`contextBudget`, `/context`); `codemode` and `autoEnableCodemode` are reported as removed. The keys stay in the file and loading does not fail.
- The shared contracts workspace package `@octocodeai/octocode-contacts` (`packages/contacts`) is renamed `@octocodeai/octocode-contracts` (`packages/contracts`). Imports of the old package name no longer resolve.

## [1.3.0]

- First changelog entry for the Octocode coding agent. The [documentation index](docs/index.md) describes the current feature set.
