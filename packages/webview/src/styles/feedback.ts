/** Loaders and run state, file edit diffs, the terminal transcript and print styles. */
export const FEEDBACK_CSS = `/* Loaders and run state */
.spinner { display: inline-block; flex-shrink: 0; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; border-radius: 50%; animation: spin .7s linear infinite; }
.btn.is-loading { cursor: progress; opacity: .85; }
.skeleton { display: grid; gap: 12px; }
.skeleton-line { display: block; border-radius: 6px; background: linear-gradient(90deg, var(--surface-3) 0%, color-mix(in srgb, var(--surface-3) 40%, var(--surface)) 50%, var(--surface-3) 100%); background-size: 200% 100%; animation: shimmer-bg 1.4s ease-in-out infinite; }
.skeleton-card { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--border-soft); border-radius: var(--radius); background: var(--surface); }
.skeleton-list { display: grid; gap: 10px; }
.skeleton-board .column { min-height: 240px; }
@keyframes shimmer-bg { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.view-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.segmented button .icon { opacity: .8; }
.run-indicator { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--accent-soft); font-size: var(--fs-sm); font-weight: 500; }
.run-orb { position: relative; width: 10px; height: 10px; border-radius: 50%; background: var(--orb, var(--accent)); }
.run-orb::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--orb, var(--accent)); opacity: 0; animation: ping 1.6s var(--ease) infinite; }
.phase-retrying, .phase-stalled { --orb: var(--warning); }
.phase-writing .phase-cursor { color: var(--accent); }
.phase-waiting { border-color: color-mix(in srgb, var(--warning) 40%, var(--border)); background: color-mix(in srgb, var(--warning) 8%, var(--surface)); }
.phase-waiting .shimmer, .run-indicator.is-stale .shimmer { background: none; color: var(--text); animation: none; }
.run-indicator.is-stale { opacity: .75; }
.run-indicator.is-stale .run-orb::after { animation: none; }
@keyframes ping { 0% { transform: scale(.6); opacity: .7; } 100% { transform: scale(1.6); opacity: 0; } }
.shimmer { background: linear-gradient(90deg, var(--text-2) 0%, var(--text) 40%, var(--accent) 50%, var(--text) 60%, var(--text-2) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer-text 2.2s linear infinite; }
@keyframes shimmer-text { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.run-elapsed, .elapsed { color: var(--text-2); font-variant-numeric: tabular-nums; font-weight: 400; }
.run-elapsed { margin-left: auto; }
.thought-for { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); font-size: var(--fs-xs); font-weight: 500; }

/* File edit diffs */
.diff-view { display: grid; gap: 8px; }
.diff-file { margin: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); }
.diff-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border-soft); background: var(--surface-2); font-size: var(--fs-xs); }
.diff-stat { margin-left: auto; font: 12px var(--mono); }
.diff-add-count { color: var(--success); } .diff-del-count { color: var(--danger); }
.diff-body { display: grid; margin: 0; max-height: 360px; overflow: auto; font: 12px/1.55 var(--mono); }
.diff-body > span { padding: 0 10px; white-space: pre; }
.diff-add { background: color-mix(in srgb, var(--success) 12%, transparent); color: var(--success); }
.diff-del { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
.diff-hunk { color: var(--tool); background: var(--surface-2); }
.diff-meta { color: var(--text-3); }

/* Terminal transcript: dark in both themes, like the terminal it mirrors */
.terminal { position: relative; display: grid; overflow: hidden; border: 1px solid #30363d; border-radius: var(--radius-lg); background: #0d1117; color: #e6edf3; box-shadow: var(--shadow-md); --term-dim: #8b949e; --term-accent: #c084fc; --term-ok: #56d364; --term-bad: #ff6b6b; --term-warn: #f2c14e; }
.terminal-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-bottom: 1px solid #21262d; background: #161b22; color: var(--term-dim); font-size: var(--fs-xs); }
.terminal-bar .btn-ghost { color: var(--term-dim); }
.terminal-bar .btn-ghost:hover:not(:disabled) { background: #21262d; color: #e6edf3; }
.terminal-bar .btn[aria-pressed=true] { background: #1a1426; border-color: #3b2a5c; color: var(--term-accent); }
.terminal-title { margin-right: auto; font-family: var(--mono); }
.terminal-dots { display: inline-flex; gap: 6px; margin-right: 6px; }
.terminal-dots span { width: 10px; height: 10px; border-radius: 50%; background: #30363d; }
.terminal-dots span:nth-child(1) { background: #ff6b6b; } .terminal-dots span:nth-child(2) { background: #f2c14e; } .terminal-dots span:nth-child(3) { background: #56d364; }
.terminal-body { display: grid; gap: 14px; margin: 0; padding: 14px 16px 18px; max-height: min(60vh, 560px); overflow: auto; font: 12.5px/1.6 var(--mono); }
.terminal-body:focus-visible { outline-offset: -2px; }
.terminal-entry { display: grid; gap: 4px; }
.terminal-prompt { display: flex; align-items: baseline; gap: 8px; }
.prompt-symbol { color: var(--term-accent); font-weight: 700; }
.terminal-command { color: #e6edf3; font-weight: 600; }
.terminal-status { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: var(--term-dim); font-size: var(--fs-xs); }
.status-done .terminal-status { color: var(--term-ok); }
.status-failed .terminal-status { color: var(--term-bad); }
.status-failed .prompt-symbol { color: var(--term-bad); }
.status-running .terminal-status { color: var(--term-accent); }
.terminal-entry .fold > summary { color: inherit; }
.terminal-output { margin: 0; padding-left: 18px; color: #c9d1d9; white-space: pre; }
.terminal-body.is-wrapped .terminal-output { white-space: pre-wrap; overflow-wrap: anywhere; }
.terminal-empty { place-items: center; padding: 48px 16px; text-align: center; font-family: var(--font); }
.terminal-muted { color: var(--term-dim); font-size: var(--fs-sm); }
.terminal-jump { position: absolute; right: 16px; bottom: 14px; box-shadow: var(--shadow-md); }

@keyframes fade-in { from { opacity: 0; } }
@keyframes slide-in { from { opacity: 0; transform: translateX(24px); } }
@keyframes pop-in { from { opacity: 0; transform: translate(-50%, -6px) scale(.98); } }

@media (max-width: 720px) {
	header.top { padding: 4px 12px 0; }
	nav.tabs { flex: 1 0 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: thin; }
	.header-row > nav.tabs { order: 1; }
	.header-row .tab { flex-shrink: 0; min-height: 40px; }
	.header-row .brand { max-width: 100%; min-width: 0; }
	.board-view > .view-heading, .backlog-view > .view-heading { flex-basis: 100%; }
	.board-view > .toolbar, .backlog-view > .toolbar { flex-basis: 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: thin; }
	.board-view > .view-heading > *, .backlog-view > .view-heading > * { max-width: 100%; }
	main { padding: 16px 16px 40px; }
	.palette-trigger { justify-content: center; min-width: 32px; padding-inline: 6px; }
	.overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
	.overview .metric { min-width: 0; padding: 8px; }
	.palette-trigger span:not(.kbd), .palette-trigger .kbd { display: none; }
	.progress-summary { margin-left: 0; }
	.board { margin-right: -16px; padding-right: 16px; }
	.column { flex: 0 0 min(85vw, 360px); min-width: 0; max-height: none; }
	.search-field { flex-basis: 100%; max-width: none; }
	.result-count { margin-left: 0; }
	.board-sort { margin-left: 0; }
	.board-overview { gap: 8px; }
	.board-view > .toolbar, .backlog-view > .toolbar { padding: 10px; }
	.sheet { inset: auto 0 0 0; top: 6vh; width: 100%; border-radius: var(--radius-lg) var(--radius-lg) 0 0; animation-name: slide-up; }
	.sheet-body, .editor { padding: 16px 18px 28px; }
	.sheet-bar { margin: -16px -18px 0; padding: 10px 12px 10px 18px; }
	.field-grid, .command-grid { grid-template-columns: 1fr; }
	.palette { top: 8px; }
}
@keyframes slide-up { from { transform: translateY(24px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
@media (forced-colors: active) {
	.badge, .btn, .card, .tab.active::after { border: 1px solid CanvasText; }
	.live-dot, .run-orb { background: CanvasText; forced-color-adjust: none; }
	.live-dot.is-paused { background: GrayText; }
	.run-orb::after { border-color: Highlight; }
	.shimmer { background: none; color: CanvasText; animation: none; }
	.skeleton-line { background: none; border: 1px solid GrayText; }
	.spinner { border-color: GrayText; border-top-color: Highlight; }
	.status-icon path[stroke], .priority-icon path[stroke] { stroke: Canvas; }
	input:focus, select:focus, textarea:focus, .card:focus-within { outline: 2px solid Highlight; outline-offset: 2px; }
}
@media print {
	header.top { position: static; backdrop-filter: none; }
	.board { flex-wrap: wrap; overflow: visible; }
	.backdrop, .palette, .palette-trigger, .header-actions { display: none !important; }
}
`;
