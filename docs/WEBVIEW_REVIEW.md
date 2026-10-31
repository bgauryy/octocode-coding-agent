# Webview dependency and UX review

Reviewed 2026-10-22 against the current working checkout. This is a review of the local workspace and its existing host integrations, not a certification of every repository subsystem or an exhaustive usability study.

See [interface architecture](INTERFACE_ARCHITECTURE.md) for current application ownership and stream contracts, and the [webview package](../packages/webview/README.md) for build and test commands.

## Library decisions

| Library            | Installed | Decision                                                                                          |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------- |
| highlight.js       | 11.12.0   | Updated from 10.7.3; use the supported core import and selected languages only.                   |
| Marked             | 18.1.1    | Updated from 18.0.11; keep Markdown parsing separate from sanitization.                           |
| DOMPurify          | 3.4.17    | Already the latest registry release checked; retain strict tag/attribute restrictions.            |
| Zustand            | 5.0.15    | Latest checked is 5.0.16, but repository package quarantine blocks it. Do not bypass that policy. |
| jsdom (tests only) | 30.1.3    | Executes the actual page in regression tests; does not ship in the browser bundle.                |

Versions were checked against the npm registry. highlight.js also identifies 11.12.0 in its [official releases](https://highlightjs.org/news). Dependencies are pinned; regenerate the browser bundle after changes and run the package build, tests, browser-import check, and generated-bundle check.

For this app, retain the existing DOM renderer with Zustand. [Radix](https://www.radix-ui.com/primitives/docs/overview/accessibility) supplies accessibility behaviors for a React interface, and [Lit](https://lit.dev/docs/components/overview/) supports reusable web components. Neither justifies a framework migration solely for styling. The renderer now compiles from typed `page.ts`, with typed transport and stream projection behind the contracts boundary. Avoid adding a second server-state cache alongside the authoritative WebSocket snapshots without a concrete query/invalidation need.

## Visual design

`packages/webview/src/styles.ts` owns the light and dark palettes and layout. Repeated theme overrides, decorative gradients, tag-color hashing, and redundant explanatory copy were removed. Status colors now agree across board columns and badges. Navigation scrolls on narrow screens, and editor fields stack into one column. Board and activity views were inspected in the local browser; this is not a full accessibility audit.

## Flow review

| Flow                         | Evidence and outcome                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture and edit work        | Title-first editor; optional relationships/details; completion evidence remains explicit. Unsaved editor drafts now survive navigation within a tab.                                           |
| Stale edits                  | Restored drafts keep their original version. The host rejects conflicting saves; the UI explains how to copy changes and discard the old draft before editing current data.                    |
| Comments                     | Stored as separate backlog-linked entities; tab-local drafts survive navigation. Posting a comment does not contact an agent.                                                                  |
| Message an agent             | Recipient required; empty/whitespace messages rejected locally. Draft and request ID survive navigation; only accepted requests clear the draft.                                               |
| Start/delegate/stop          | Existing authenticated host operations and durable receipts remain authoritative. Accepted requests are not presented as completed work. Permissions still belong to the host.                 |
| Observe results              | Markdown is default; code supports language labels, highlighting, copy, wrap and source inspection. Cached result nodes preserve inspection state and focused controls across appended events. |
| Live updates                 | Identical event snapshots retain stable state; pause/resume remains available. Only retained event cards are cached. Session changes clear drafts and old cached results.                      |
| Completion and relationships | Existing host tests cover goal/reason requirements, completion records, dependency rules and version conflicts. The UI does not invent completion percentages for agents.                      |
| Audit and recovery           | Per-item audit, workspace history and explicit request receipts remain available. Existing host tests cover authorization, deduplication and failure behavior.                                 |
| Keyboard dialogs             | Disabled controls are excluded from focus wrapping. Browser checks verified Shift+Tab containment, Escape, restored draft and return focus.                                                    |
| Rich-text security           | Rendered-page tests verify scripts/images/event attributes and executable links stay inert; Markdown and highlighted code pass through the sanitizer.                                          |

The interaction approach follows [Fluent's agent guidance](https://fluent2.microsoft.design/responsible-AI): make status and next steps understandable and allow explicit steering. Dialog behavior is checked against the [WAI modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## Verification and limits

Twenty-one webview tests and 103 focused native host tests passed after the application-port migration. The webview tests include actual generated-page execution, retained focus and code controls during live updates, message-draft navigation and acceptance, editor draft restoration/discard, source sanitization, filtering, and session isolation. The package builds and browser/bundle checks passed. A real browser verified editor keyboard behavior and draft restoration using isolated sample data.

Drafts are held only in this tab's memory, so closing/reloading it loses them. No live provider was invoked in this review. Mobile touch, screen-reader announcements, large-data performance, and a complete WCAG audit remain unverified. File paths are references, not a scoped file browser; code blocks do not execute. Reviewable diffs and web approval cards require explicit backend contracts before implementation. Repository-wide type-check and offline-build results must be reported separately from these package checks.

The send flow also protects its form while a request is pending, so an early WebSocket receipt cannot replace the composer before the HTTP acknowledgement clears it. A generated-page test covers that ordering. The final repository-wide type check, browser checks, package-boundary checks, and generated-bundle check pass. Shared TypeBox remains 1.3.27; its protocol consumers were not migrated as part of this UI library update.

## React migration (2026-10-22, later)

This section supersedes the earlier "retain the existing DOM renderer" decision; the sections above remain as the record of that review.

**Decision.** The page is now a React 19 app with Zustand stores, at the maintainer's request for composable, tested components. The constraints recorded above still hold: no second server-state cache beside the WebSocket snapshots, strict sanitization, and an inert offline export. React and React DOM are development dependencies bundled into the generated script; the published package still exports HTML and script strings.

**Structure.** Pure logic (`src/app/model/`) is separate from the UI kit (`src/app/ui/`), the views (`src/app/features/`) and the live-only module (`src/app/live/`). The offline build replaces the live module with a `null` stub at bundle time instead of stripping marked source text. See the [package README](../packages/webview/README.md#structure).

**Visual design.** Tokens match the Octocode terminal themes (purple accent, GitHub-like neutrals). The interaction patterns follow established tools: board and issue peek in a side sheet, a ⌘K command palette with an ARIA combobox, `/` to search, filters kept in the URL, and sortable table headers that expose `aria-sort`.

**Agent activity.** These choices were checked against their sources:

- Consecutive tool calls collapse into a status group, and a group with a failure opens by default. AI Elements labels tool states Pending, Running, Completed and Error, and "Auto-opens completed tools by default" ([AI Elements Tool](https://elements.ai-sdk.dev/components/tool)).
- The streaming body is not a live region. A separate polite status region announces start and completion only, following "do not make the streaming response body itself an automatic announcement target" ([accessible streaming chat](https://azukiazusa.dev/en/blog/accessible-streaming-chat-ui)).
- Rows subscribe narrowly. Unchanged events keep their identity, so memoized rows skip rendering, as in the selector-driven thread pattern where "only one component re-renders per delta—not 100" ([MUI Chat](https://mui.com/x/react-chat/core/examples/selector-driven-thread/)). Zustand warns that selecting the whole store updates "on every state change" ([Zustand](https://github.com/pmndrs/zustand)).
- Deltas are coalesced per animation frame, with a timeout so hidden tabs, which pause frames, keep updating.

The feed keeps at most 200 events, so it is not virtualized. No authoritative item-count threshold for virtualization was found.

**Security change.** The offline export's host test previously scanned the bundle text for sink names and URLs. React DOM contains `innerHTML` (for `dangerouslySetInnerHTML`), its own `javascript:` URL-blocking pattern, SVG namespace URIs and error-page links, so that literal scan cannot pass. With the maintainer's approval the guard changed:

- The host test keeps the CSP, markup and network-API literal checks.
- `webview/test/security.test.ts` checks that this package's source contains no sink.
- The same test runs the offline export on hostile data across every view, with each HTML sink and network API trapped. A mutation check confirmed that an injected `innerHTML` write fails it.
- Oxlint (`react/no-danger`) forbids `dangerouslySetInnerHTML`; the review ran when Biome enforced the same rule.

**Cost.** The offline export script grew from about 20 KB to about 268 KB, and the live script from about 349 KB to about 609 KB, mostly React DOM.

**Verification.** All results are from this run:

| Check                                                                                       | Result                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webview tests: model, live model, component, page flows, security, state, stream, transport | 60 passed                                                                                                                                                                                            |
| Host backlog/workspace tests (four files)                                                   | 41 passed                                                                                                                                                                                            |
| Repository script tests                                                                     | 25 passed                                                                                                                                                                                            |
| Browser smoke, bundle freshness, package boundaries, Biome                                  | Passed                                                                                                                                                                                               |
| Repository `tsc --noEmit`                                                                   | Reports only two errors in `coding-agent/src/octocode/hooks/register.ts`; that file had uncommitted changes before this work, and the errors remain with this change's `tsconfig.json` edit reverted |

Real Chrome (headless, driven over the DevTools Protocol) rendered:

- the board, table, tree, sheet, palette and editor, each in light or dark, with the board in both;
- the board and sheet at 390 px wide;
- the live activity, agents and composer against a mock host streaming application frames.

Not verified: screen-reader announcements with VoiceOver or NVDA, touch interaction on devices, and a running Octocode session with a real provider.

### Addendum (2026-10-23): terminal view, run indicators and loaders

- **Terminal view.** The Terminal button, palette command and `T` shortcut open a read-only transcript of tool calls. The protocol replaces a tool's streamed arguments with its output when the call completes, so the projection keeps the first-seen arguments to show `bash npm run check` rather than `bash`.
- **Run indicators.** These are derived from run state: thinking, writing a response, or running a named tool, with elapsed time and a "Thought for" duration on a run's first answer. Real reasoning text would need a contracts protocol change and was not attempted.
- **Loaders.** The live board previously showed its empty-board message before the first snapshot arrived; it now shows a skeleton until then.
- **Verification.** The webview has 74 tests, including page-flow tests for the terminal and for the board loading state, and the 41 host tests pass. Real Chrome against the mock host showed the transcript with arguments, status and output, the thinking and writing indicators, "Thought for 2s", and the loading skeleton.

### Addendum (2026-10-23): per-tool end-to-end review

**Method.** Read-only catalogues of every tool family (file, bash, web, browser, askUser, archive, agent and its modes, external agents, coordinate, sendMessage, backlog, memory, Octocode MCP, generic MCP, tool_search). For each: its arguments, partial updates, result text, details, images and errors on both event paths. Then `coding-agent/test/application-webview-tools.test.ts` ran write, read, edit, bash (success, failure and a command containing a secret) and a missing-file read in a real session, through the application service and into the browser stream, projection and renderers.

**Fixed.**

- **No argument labels.** `tool.started` carried no arguments, so a finished call showed only its name. `hint` was added to contracts tool events and `ApplicationTool`. The host sends the existing redacting `toolHint(args)` (application service, and the workspace `tool.start` details), the stream keeps it, and the end-to-end test asserts the secret never reaches a frame.
- **Progress mistaken for arguments.** The earlier argument inference read the first streamed progress as arguments; it was removed.
- **Workspace calls ran forever.** That path publishes start and result as two events with no shared id, so every call showed as running indefinitely. Results now settle the oldest open start of the same tool.
- **Agent progress floods.** It reports on every step; only the latest report per agent is kept.
- **Message placeholders.** Assistant turns that only called tools rendered `[Tool call: x]` messages; those placeholders are dropped.
- **Text clean-up.**
  - Colour codes are stripped in feed cards as well as the terminal.
  - " failed" is removed from tool names.
  - Trailing output newlines are trimmed.
  - MCP names show as `server/tool`.
- **File edits.** File-tool diffs (workspace path) render as a diff view.

**Open, host-side.**

- **Long output loses its head.** The application path keeps the last 16000 characters of progress and results, so a long web page, browser snapshot or archive page loses its first lines and summary. Head-and-tail truncation would keep both.
- **Images dropped.** Images are dropped on both paths: browser screenshots and web images become a text line naming a saved file.
- **No details on the application path.** The stream carries no tool details, so file diffs render only on the workspace path.
- **Coarse agent labels.** The single `agent` tool wraps task, external, coordinate and message modes, and `toolHint` does not read `input.goal` or `input.action`. Moving `callTarget`/`queryTarget` from `octocode/ui/activity.ts` into a pure module would label agent calls and Octocode MCP query batches better.
- **askUser cannot be answered from the browser.** It waits on a terminal or RPC dialog.
- **Progress still evicts history.** Agent progress also evicts older workspace events on the host (200-event cap); the webview collapse is display-only.
- **Durations.** `durationMs` from `tool_execution_end` is not forwarded, so elapsed time is measured from when the browser first saw the call.

**Verification.**

| Check                                                                | Result    |
| -------------------------------------------------------------------- | --------- |
| Webview tests                                                        | 83 passed |
| Contracts tests                                                       | 4 passed  |
| Application port, nested tool calls and the new end-to-end tool test | 17 passed |
| Workspace, API and backlog host tests                                | 72 passed |
| Repository script tests                                              | 25 passed |
| Browser smoke, bundle freshness, boundaries, Biome                   | Passed    |

Repository `tsc` still reports only the two pre-existing `hooks/register.ts` errors. Real Chrome against a mock host using the real frame shapes showed settled workspace calls, hints on both paths, `octocode/localSearch`, a rendered diff, one progress card per agent and no placeholder messages. Native Octocode tools (file, agent, web, browser, MCP) were reviewed from source and covered by unit tests on their real formats; only the built-in tools ran in the end-to-end session.
