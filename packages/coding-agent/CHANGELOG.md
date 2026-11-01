# Changelog

Entries are shown once by `octocode` after an update and on demand with `/changelog`. Each heading names the package version; earlier releases predate this file.

## [Unreleased]

- A message typed in the terminal or /web that names an image file (an absolute, `~/` or `./` path, a quoted path with spaces such as a pasted macOS screenshot, a drag-and-drop path or a `file://` URL) now sends the image to the model with the text, so a pasted path or a `Ctrl+V` clipboard image reaches the model after startup. Up to 8 images attach per message; see [attach images by path](docs/models.md#attach-images-by-path).
- Settings files with a root key Octocode does not read now produce a warning at startup, naming the key and file. A `compaction` block, which has had no effect since compaction limits became built-in, is reported with its replacement (`contextBudget`, `/context`); `codemode` and `autoEnableCodemode` are reported as removed. The keys stay in the file and loading does not fail.
- The shared contracts workspace package `@octocodeai/octocode-contacts` (`packages/contacts`) is renamed `@octocodeai/octocode-contracts` (`packages/contracts`). Imports of the old package name no longer resolve.

## [1.3.0]

- First changelog entry for the Octocode coding agent. The [documentation index](docs/index.md) describes the current feature set.
