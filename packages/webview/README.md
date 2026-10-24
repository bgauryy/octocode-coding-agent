# Octocode webview

Browser presentation for the local Octocode workspace: task board, planning backlog, table, tree and attention views, an item sheet, a command palette, agent views, activity, audit, Markdown and code rendering, and Zustand state. This package consumes `@octocodeai/octocode-contacts`; it does not access databases, launch agents, or grant permissions.

The coding-agent host owns model, skill and MCP settings. See [CONFIGURATIONS.md](../../CONFIGURATIONS.md) for global/workspace locations and [interface architecture](../../docs/INTERFACE_ARCHITECTURE.md) for the terminal/browser boundary.

The coding-agent host serves the generated page through its authenticated local server. Import `renderBacklogHtml` from `@octocodeai/octocode-webview`. The page includes its compiled adapter. The optional `state` and `markdown` subpaths expose browser utilities: `createWorkspaceStore`/`selectEvents`, and `safeMarkdownLink`/`sanitizeMarkdown`.

From the repository root:

- `yarn run generate:workspace` rebuilds the checked-in browser bundle after browser source changes.
- `yarn workspace @octocodeai/octocode-contacts run build` builds shared declarations first.
- `yarn workspace @octocodeai/octocode-webview run build` builds this package.
- `yarn workspace @octocodeai/octocode-webview run test` runs model, component, page-flow and security tests.
- The repository's Oxlint configuration covers this package with React, React hooks and accessibility rules (`yarn run lint` from the root); Oxfmt formats it with the rest of the code (`yarn run format`). `typecheck` checks the package with DOM and JSX settings.
- `yarn run check` also verifies TypeScript, lint and formatting, browser imports, bundle freshness and package boundaries.

## Structure

The browser entry is `src/page.tsx`, a React 19 app bundled into the page. React and React DOM are development dependencies: the published package ships the generated script as a string, not a runtime React dependency.

- `src/app/model/`: pure logic with no React: hash routing, filtering and sorting, the derivation tree, attention, editor values to `BacklogMutation`. Unit-tested in `test/model.test.ts`.
- `src/app/ui/`: the design-system kit: buttons, badges, status and priority icons, fields, segmented control, `Sheet` (modal side sheet with focus trap and focus return), `LongText`.
- `src/app/features/`: the shell (`App.tsx` composes these), header and tabs, board, table, tree, attention, item detail and the ⌘K command palette.
- `src/app/live/`: everything that needs the authenticated host: the session provider, activity, agents, audit, item comments and controls, the editor and the Markdown renderer. `App` receives it as a `LiveExtension`; the offline build substitutes `live/offline.ts`, which exports `null`.
- `src/transport.ts` owns the authenticated HTTP/WebSocket lifecycle; `src/application-stream.ts` validates shared application frames, applies ordered updates, reconciles receipts and requests resynchronization after gaps. The host remains the command authority. Closing the view only disconnects it.

Views are controlled by the URL hash (`#backlog`, `#board?tag=web`, `#table?state=todo`, `#B12`, `#B12/edit`, `#new`), so links, reloads and the back button restore filters and open items. Board and Backlog share filters for priority, type, assignee, tag and readiness, search including comments, and priority/recent-update sorting. Backlog lists upcoming To do and Backlog work; Board also shows In progress and Done. Cards show priority, assignment, comments and dependency warnings. Keyboard: ⌘K or Ctrl+K opens the palette, `/` focuses the view's search, `C` creates an item and `T` opens the terminal view on the live page, and Escape closes the topmost sheet or dialog.

On live boards, **Implement** on a card or backlog row and **Implement item** in the detail sheet send the existing `work` command with the item ID and version. The host resolves authoritative details and all comments, then sends `Implement backlog item B12` to the current agent through its normal session flow. Controls share request state across navigation, preserve IDs after uncertain network failures, explain unavailable actions, and link accepted work to Activity. Posting or clearing an unsent comment is required before implementation. The host remains responsible for claims, dependency checks, version conflicts, deduplication and permissions. Offline exports have no implementation controls.

## Rendering and live updates

The generator builds separate live and offline scripts from the same entry. The offline build swaps out the live extension at bundle time, so it contains no transport, Markdown parser or editor. The live build supports ordered user and assistant content, source citations, reasoning summaries, images, media/resource fallbacks, tool progress, session controls and the backlog/agent flows. Images can be attached to prompt and queue commands, including image-only messages. Stream cursors remain in memory; drafts stay local to the tab.

Snapshots and stream frames are merged into one feed of at most 200 events. Unchanged events keep their object identity, so memoized rows render only when their own event changes, and bursts of deltas are coalesced to one update per animation frame, with a timeout so hidden tabs keep up. Two or more consecutive tool calls collapse into one group, which opens when a call failed. The feed is a named `role="log"` that stays silent; a separate status region announces only run start and completion.

While a run is active, a run indicator shows its phase with elapsed time. Provider-supplied reasoning summaries render as separate expandable blocks; opaque provider continuation data is not exposed. Rich message blocks preserve tool-call order, and tool state renders inline at the call. Legacy text-only frames remain supported. The **Terminal** button opens a read-only tool transcript; it never runs commands. Commands execute in the agent session under host permissions.

Large text and JSON expose a full-content action, images use authenticated session assets, and older messages load through history pages. Blob URLs are revoked when replaced or unmounted. Failed and interrupted responses have explicit states. Transcript resets discard old branch pages, and context-only custom messages remain hidden. See the [application boundary](../../docs/INTERFACE_ARCHITECTURE.md#ordered-content-and-assets) for limits and transport ownership.

Loading states: a live page shows skeleton columns until its first backlog snapshot arrives (the host embeds an empty placeholder), agent views show skeletons while connecting, and buttons that send requests show a spinner, keep their label, and block repeat clicks.

When disconnected, the page identifies cached session data beside agent controls. HTTP commands still receive host validation; reconnection does not replay commands automatically. Session changes discard old agents and ignore late command responses. Failed requests can be retried, while uncertain delivery keeps the same request ID to avoid duplicate work. Audit history has a retry action that preserves already loaded pages.

## Visual design and safety

Visual tokens and layout rules live in `src/styles.ts`. They share the Octocode palette with the terminal themes (`coding-agent/src/modes/interactive/theme/octocode-*.json`): purple accent and GitHub-like neutrals, in one light and one dark palette. Colors identify status, always paired with an icon shape; tags and metadata stay neutral. Reduced motion and forced colors are respected.

Static backlog exports remain self-contained and offline. Live pages communicate through the routes and command schemas owned by contacts. Rich text is parsed, sanitized to an allowlist, and converted to React elements through a second allowlist; nothing renders through `innerHTML` or `dangerouslySetInnerHTML`, and code blocks cannot execute commands. React DOM contains sink code paths this page never uses, so `test/security.test.ts` keeps every HTML sink out of this package's source and runs the offline export on hostile data with each sink and network API trapped.
