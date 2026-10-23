# Octocode webview

Browser presentation for the local Octocode workspace: backlog board, table, tree and attention views, an item sheet, a command palette, agent views, activity, audit, Markdown and code rendering, and Zustand state. This package consumes `@octocodeai/octocode-contacts`; it does not access databases, launch agents, or grant permissions.

The coding-agent host owns model, skill and MCP settings. See [CONFIGURATIONS.md](../../CONFIGURATIONS.md) for global/workspace locations and [interface architecture](../../docs/INTERFACE_ARCHITECTURE.md) for the terminal/browser boundary.

The coding-agent host serves the generated page through its authenticated local server. Import `renderBacklogHtml` from `@octocodeai/octocode-webview`. The page includes its compiled adapter. The optional `state` and `markdown` subpaths expose browser utilities: `createWorkspaceStore`/`selectEvents`, and `safeMarkdownLink`/`sanitizeMarkdown`.

From the repository root:

- `npm run generate:workspace` rebuilds the checked-in browser bundle after browser source changes.
- `npm run build --workspace=@octocodeai/octocode-contacts` builds shared declarations first.
- `npm run build --workspace=@octocodeai/octocode-webview` builds this package.
- `npm run test --workspace=@octocodeai/octocode-webview` runs model, component, page-flow and security tests.
- `npm run lint --workspace=@octocodeai/octocode-webview` runs Biome (formatting, React hooks and accessibility rules); `lint:fix` applies safe fixes. `typecheck` checks the package with DOM and JSX settings.
- `npm run check` also verifies TypeScript, browser imports, bundle freshness, package boundaries and this package's lint.

## Structure

The browser entry is `src/page.tsx`, a React 19 app bundled into the page. React and React DOM are development dependencies: the published package ships the generated script as a string, not a runtime React dependency.

- `src/app/model/`: pure logic with no React: hash routing, filtering and sorting, the derivation tree, attention, editor values to `BacklogMutation`. Unit-tested in `test/model.test.ts`.
- `src/app/ui/`: the design-system kit: buttons, badges, status and priority icons, fields, segmented control, `Sheet` (modal side sheet with focus trap and focus return), `LongText`.
- `src/app/features/`: the shell (`App.tsx` composes these), header and tabs, board, table, tree, attention, item detail and the ⌘K command palette.
- `src/app/live/`: everything that needs the authenticated host: the session provider, activity, agents, audit, item comments and controls, the editor and the Markdown renderer. `App` receives it as a `LiveExtension`; the offline build substitutes `live/offline.ts`, which exports `null`.
- `src/transport.ts` owns the authenticated HTTP/WebSocket lifecycle; `src/application-stream.ts` validates shared application frames, applies ordered updates, reconciles receipts and requests resynchronization after gaps. The host remains the command authority. Closing the view only disconnects it.

Views are controlled by the URL hash (`#table?state=todo`, `#B12`, `#B12/edit`, `#new`), so links, reloads and the back button restore filters and open items. Keyboard: ⌘K or Ctrl+K opens the palette, `/` focuses the view's search, `C` creates an item and `T` opens the terminal view on the live page, and Escape closes the topmost sheet or dialog.

## Rendering and live updates

The generator builds separate live and offline scripts from the same entry. The offline build swaps out the live extension at bundle time, so it contains no transport, Markdown parser or editor. The live build supports partial assistant messages, tool progress, session controls and the backlog/agent flows. Stream cursors remain in memory; drafts stay local to the tab.

Snapshots and stream frames are merged into one feed of at most 200 events. Unchanged events keep their object identity, so memoized rows render only when their own event changes, and bursts of deltas are coalesced to one update per animation frame, with a timeout so hidden tabs keep up. Two or more consecutive tool calls collapse into one group, which opens when a call failed. The feed is a named `role="log"` that stays silent; a separate status region announces only run start and completion.

While a run is active, a run indicator shows its phase (thinking, writing a response, or running a named tool) with elapsed time; the first answer of a run records how long the run thought before it. These are derived from run state: the application protocol carries no model reasoning text. The **Terminal** button (header, palette or `T`) opens `#activity?mode=terminal`, a read-only transcript of tool calls: each command labelled with the host's redacted argument hint (`toolHint`, sent as `hint` on `tool.started`), its output, status and elapsed time, colour codes stripped, pinned to the newest line until the reader scrolls up. MCP tools show as `server/tool`. Workspace-path starts are settled by their results, file edits show their unified diff, repeated agent progress keeps only the latest report per agent, and the host's `[Tool call: …]` placeholders are dropped from messages because the calls appear as their own events. It never runs commands; those run in the agent's session under the host's permissions.

Loading states: a live page shows skeleton columns until its first backlog snapshot arrives (the host embeds an empty placeholder), agent views show skeletons while connecting, and buttons that send requests show a spinner, keep their label, and block repeat clicks.

## Visual design and safety

Visual tokens and layout rules live in `src/styles.ts`. They share the Octocode palette with the terminal themes (`coding-agent/src/modes/interactive/theme/octocode-*.json`): purple accent and GitHub-like neutrals, in one light and one dark palette. Colors identify status, always paired with an icon shape; tags and metadata stay neutral. Reduced motion and forced colors are respected.

Static backlog exports remain self-contained and offline. Live pages communicate through the routes and command schemas owned by contacts. Rich text is parsed, sanitized to an allowlist, and converted to React elements through a second allowlist; nothing renders through `innerHTML` or `dangerouslySetInnerHTML`, and code blocks cannot execute commands. React DOM contains sink code paths this page never uses, so `test/security.test.ts` keeps every HTML sink out of this package's source and runs the offline export on hostile data with each sink and network API trapped.
