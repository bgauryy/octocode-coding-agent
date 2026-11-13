# Terminal interface audit

## Executive summary

Fixed confirmed defects in shared composition, footer visibility, theme state, queue controls and session actions. Existing staged and unstaged work was preserved. The design keeps the normal footer compact, makes important state discoverable, and bounds exceptional output so it cannot consume the terminal.

Database schemas, RPC contracts, external MCP schemas/descriptions and agent prompts were preserved. Session defects were in selector state and asynchronous completion handling. Follow-up work also fixes failed-startup cleanup, tool-purpose visibility and web board keyboard focus. No runtime dependency on the migration reference was introduced.

## Findings and implementation

| Priority | Confirmed cause | Result | Source owner |
| --- | --- | --- | --- |
| High | Footer treated retry and timer status keys as already rendered when they had no assigned position | Retry waits and timer judging spend are eligible for display | `packages/coding-agent/src/octocode/ui/footer/rows.ts` |
| High | Width fitting removed warnings and errors alongside routine status | Severity takes priority; bounded overflow, omitted-alert counts and `/status` preserve access | `rows.ts`, adjacent `fit.ts` |
| High | Cached Box mouse rows referenced detached children and used unpainted padding | Detached actions reject clicks; painted geometry stays stable until redraw; empty frames replace retained references | `packages/tui/src/components/box.ts` |
| High | Fast catalog rows bypassed the selector's actionable session cache | Visible quick results remain available to delete and rename while full history loads | `packages/coding-agent/src/modes/interactive/components/session-selector/loads.ts` |
| High | Duplicate mutation submissions and completions outlived the session picker | One pending mutation, visible progress, stale-selection checks and disposal guards | `session-selector.ts` |
| High | Startup registered process/stream handlers but did not roll them back after initialization rejected | Partial startup stops and handlers are always removed; the original error survives cleanup/diagnostic failures | `interactive-mode/startup.ts`, `startup-cleanup.ts` |
| High | MCP input purpose fields were ignored; returned fields were shortened even in expanded views | Explicit Call/Result groups show supplied top-level and per-query Goal/Reason fields, retaining returned indices | `octocode/ui/reason-row.ts`, `purpose-block.ts`, `purpose-data.ts` |
| High | Web board focus depended on a zero-delay timer racing React commit | A committed consumer claims a matching pending ID once; terminal actions expire matching intents | `packages/webview/src/app/features/board-flow.tsx`, `BoardCard.tsx` |
| Medium | Text, Markdown and Box calculated padding differently at narrow widths | One shared padding calculation keeps rendering and click coordinates aligned | `packages/tui/src/utils.ts`, `components/{text,markdown,box}.ts` |
| Medium | Concrete theme defaults cached terminal colors but omitted effective appearance | Palette-only themes refresh inferred foreground/background when appearance changes | `packages/coding-agent/src/theme/theme-class.ts` |
| Medium | Management badges, pagination and borders exceeded available columns | Bounded rows, retained selection marker and empty zero-width border | `theme/manage-page.ts`, `theme/dynamic-border.ts` |
| Medium | Queue hints hardcoded default keys and aliases shadowed configured actions | Configured actions take precedence; hints show usable keys, including available deletion alternatives | `components/queue-list.ts` |
| Medium | Empty queues hid their usable fallback close key when inactive item bindings claimed it | Empty-state hints reflect the active controls | `components/queue-list.ts` |
| Medium | Alert priorities could displace the details route; dedicated active-work status omissions lacked a route before spend | Reserved route space preserves `/status` under alert pressure, still within five rows | `octocode/ui/footer/rows.ts` |
| Medium | Session errors, fallback footer labels and queue metadata accepted terminal controls | Existing sanitizers protect displayed text; errors retain readable text labels | Selector header, fallback footer and queue component |

`/status` now adds a snapshot of every current footer status to the transcript. It retains the full text, sanitizes controls and labels warnings/errors independently of color. The compact footer normally uses two rows and never exceeds five rows for alerts. The complete report is intentionally transcript content rather than sticky chrome.

Tool cards display only provided purpose fields. Goals have stronger emphasis; reasons remain readable as secondary text. Query indices remain associated with their data, including out-of-order returned envelopes. Full arguments and results are retained; dedicated purpose rows remove redundant argument presentation. Collapsed metadata has an expansion hint; expanded terminal cards and both full HTML export paths retain all fields. Ordinary transcript scrolling remains necessary for arbitrarily large cards.

## Design decisions and alternatives

- Preserve the tested palette: existing contrast checks passed. Fix stale appearance state instead of introducing an unverified global recoloring.
- Preserve bounded chrome: arbitrary alert wrapping was rejected in independent review because a large extension error could consume the screen. Two alert text rows and an explicit overflow route replace unbounded wrapping.
- Use shared composition rules: one padding helper prevents individual components from drifting across rendering and input handling.
- Preserve operation semantics: closing a picker does not cancel a rename/delete already started. The pending UI explains this, and completion cannot reopen the disposed picker.
- Avoid speculative persistence changes: retain DB boundaries, session identity, cancellation and public contracts. Fix the proven UI cache mismatch in its owner.
- Retain efficient rendering: existing render-signal, isolation, virtual-scroll and scheduler tests were exercised; no speculative pacing rewrite or measured speedup claim was made.

## Execution and review

| Work stream | Owner | Acceptance evidence |
| --- | --- | --- |
| Footer and fitting | `footer` agent | Restored hidden data; bounded alerts; safe labels; focused tests |
| Composition and lifecycle | `rendering` agent | Narrow-width and detached-action regressions; rendering/scroll checks |
| Themes and shared chrome | `themes` agent | Appearance cache, badges, selection and zero-width regressions |
| Commands and sessions | `commands_sessions` agent | Async catalog/mutation/disposal and safe-feedback regressions |
| Queue, full status report, docs and integration | Coordinator | Remapping, empty queue, full-data snapshot and integration checks |
| Adversarial source review | `review` agent | Found and resolved shadowed shortcuts, unbounded alerts and unsafe session headers |
| Tool-purpose data and full exports | `rendering` agent | Pending, batched, returned, indexed, deduplicated, sanitized and expanded metadata regressions |
| Screenshot matrix | `themes` agent and coordinator | Direct source capture, 96 terminal configurations, image inspection and 97 automated checks |
| Web keyboard focus | `review` and `board_focus` agents | Deterministic timer/commit failure reproduction and 36 passing focus/board tests |

Independent work used separate file ownership. Integration and final checks followed the source changes. The command picker already handled search, arguments, descriptions and insertion correctly; no unsupported command redesign was made.

## Verification

| Check | Evidence |
| --- | --- |
| Footer core/native suites | 73 tests passed across seven files |
| Rendering, composition and lifecycle | 39 tests passed; virtual scroll 10 passed; isolated scheduler 7 passed |
| Themes and management | Nine suites / 55 tests passed; final focused regressions six tests passed |
| Session selector integration | Six files / 34 tests passed; final async/feedback/untrusted suites 17 tests passed |
| Queue and full status integration | Five files / 31 tests passed |
| Follow-up footer/queue | 52 footer tests and 30 queue tests passed |
| Startup rollback | Five strengthened regressions passed, including 20 failed-init cycles and failing cleanup/diagnostics; broader lifecycle group 34 passed |
| Tool metadata and full exports | 40 core/export tests and 19 native/render tests passed |
| Screenshot matrix | 96 frames captured through direct Node source execution; 97 automated checks passed; 96 PNGs/four contact sheets generated and visually reviewed as described below |
| Web keyboard focus | 36 tests passed, including all 25 original board drag/drop tests |
| Complete webview suite | 86 files / 651 tests passed after final focus changes, with one worker and unchanged timeout limits |
| Contracts | 113 tests across 15 files passed |
| Common locks | 24 tests across five files passed; concurrent typing corrections independently verified |
| Repository checks | All 11 passed after final code changes; `.octocode/tmp/tui-followup/check-complete-final.log` |
| Build and CLI | Final offline bundle compilation passed; bundled `--help` and `--version` succeeded; local-API prompt startup encountered sandbox socket `EPERM` |
| Full TUI suite | Four real-tmux tests blocked by denied socket creation; three timing assertions exceeded limits during concurrent suites |
| Portable full TUI rerun | 1,608 tests passed, zero failed, sequential execution; the four socket-dependent tmux cases were explicitly excluded and native-platform skips retained |
| Performance rerun | All 20 tests in the three affected files passed sequentially with unchanged thresholds; parser stress case 122.7 ms against 1,500 ms limit |
| Full scripted end-to-end suite | Initial full run stopped after repeated sandbox startup failures; final unfiltered selection with `--bail=1` stopped at denied loopback bind (`e2e-plugin-agents`); not passed |
| Isolated command end-to-end | `/status` and other non-listener command assertions succeeded; `/api`, `/backlog`, `/remote`, `/web` failed because local listeners were denied |

The host provides Node 26.4.0. The required Node 24 line remains unverified. Color-sensitive tests were rerun with `NO_COLOR` unset, `TERM=xterm-256color`, and `COLORTERM=truecolor`; inherited no-color/dumb-terminal settings caused the initial color failures. One scheduler timing assertion failed during parallel load and passed in isolation without changing the assertion or scheduler. The full-suite timing failures also passed after concurrent process suites stopped; this supports a load-related explanation, not a demonstrated parser optimization or universal timing guarantee.

The portable rerun used `yarn node --test --test-concurrency=1 --test-global-setup=../../node-test.global.ts --test-reporter=spec` in the TUI workspace, with `--test-skip-pattern` naming the four cases that create real tmux sockets. No source assertions or thresholds were changed. See `.octocode/tmp/tui-followup/tui-portable.log` and `environment-probe.log`; the latter again records `EPERM` for both loopback and Unix-socket binds.

Suite counts overlap; they are not an aggregate unique-test count. Full logs are retained under `.octocode/tmp/`. Runtime claims above are limited to executed tests; there was no user study, paid model evaluation or end-to-end latency benchmark.

## Screenshot loop and coverage

| Axis | Values |
| --- | --- |
| Theme | Dark, light |
| Width | 40, 80, 120 columns |
| Screen mode | Regular, fullscreen |
| State | Idle, running, warning, error, queue, session picker, input query metadata, returned query metadata |
| Height | 24 rows |
| Product | 96 combinations |

The fixture runs production components and both production screen renderers through xterm's terminal emulator. Native footer rendering, the real working indicator, editor/dialog placement and tool cards are used. The emulator's actual cells, RGB colors and attributes are rasterized with Menlo/CoreText-compatible AppKit drawing. All data is synthetic; no model/provider/API requests are required.

The loop found and fixed displaced details routes, clipped purpose fields, unnecessary raw argument layout, missing pending-call metadata and source-runtime syntax that transpiled tests did not expose. The final matrix asserts visible provided goals/reasons and query indices, explicit Call/Result headings, useful status and controls, and no component overflow. The coordinator inspected all four overview sheets and representative full-size frames; an independent reviewer also inspected tool and overview images.

Captures are headless terminal test screenshots, not photographs of a desktop terminal. Computer-use access to Terminal.app was denied. Actual terminal fonts, host color overrides, motion and desktop interaction therefore remain separate coverage gaps. At narrow widths, long tool titles or argument rows can scroll above the viewport; all provided purpose text in the moderate two-query scenarios remains visible, while full argument/history data stays scrollable.

Reproduce source capture with `yarn node --import ./packages/coding-agent/scripts/source-resolver.ts ./packages/coding-agent/test/fixtures/tui-design-qa.ts --capture-dir .octocode/tmp/tui-design-qa-cells`, with `NO_COLOR` unset and `TERM=xterm-256color COLORTERM=truecolor`. Run `test/tui-design-permutations.test.ts` in the coding-agent workspace. The screenshot archive includes all 96 frames, four overview sheets, source cells, checksums and the rasterizer source.

## Research basis

| Primary source | Applied principle and limit |
| --- | --- |
| [W3C: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color/) | Give status meaning a visible cue beyond color. Web guidance informs the design; it does not establish universal terminal accessibility compliance. |
| [W3C: Contrast Minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum/) | Assess text against actual adjacent backgrounds. User-controlled terminal palettes limit universal contrast claims. |
| [Command Line Interface Guidelines](https://clig.dev/) | Restrained semantic color, discoverable help, visible progress and errors, and recoverable interaction. |
| [Node.js TTY documentation](https://nodejs.org/api/tty.html) | Terminal columns, resize events and color capabilities are runtime inputs, not fixed layout assumptions. |

## Remaining verification

Run the final bundle and scripted end-to-end suite on Node 24 in an environment permitting local HTTP and Unix-socket binds. Inspect real terminal rendering in fullscreen and regular modes at narrow/wide sizes, light/dark appearances and reduced motion. These gaps are explicit; the changes are not declared release-certified.

The initial blocked end-to-end run emitted `MaxListenersExceededWarning` without a registration stack. Follow-up reproduced a concrete production leak: failed initialization retained handlers. That failure path is fixed and tested across 20 attempts, including cleanup and diagnostic failures. The precise historical warning emission site still cannot be certified from the original log; full process verification with warning traces remains blocked by the environment.

Confidence is high in the directly reproduced fixes and focused regressions, and lower in cross-terminal behavior and supported-runtime integration until the remaining checks run.
