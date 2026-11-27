/** The desktop-app look in an app window: a title area that drags, calmer surfaces, raised cards and the notification control. */
export const APP_CSS = `/* App window */
body { overscroll-behavior: none; -webkit-user-select: none; user-select: none; }
main, input, textarea, pre, code, .sheet, .doc-body, .terminal, [contenteditable] { -webkit-user-select: text; user-select: text; }
header.top { box-shadow: 0 1px 0 var(--border), var(--shadow-sm); background: color-mix(in srgb, var(--surface) 82%, var(--bg)); }
.header-row { -webkit-app-region: drag; }
.header-row :is(button, a, input, summary, select, output, .notify-control, .menu-panel) { -webkit-app-region: no-drag; }
.brand { font-size: var(--fs-md); letter-spacing: -.005em; }
.brand-mark { width: 20px; height: 20px; border-radius: 6px; box-shadow: var(--shadow-sm), inset 0 0 0 1px rgb(255 255 255 / .18); }
main { max-width: 1680px; margin: 0 auto; }
.btn:focus-visible, .palette-trigger:focus-visible, .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.notify-control { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.notify-state { display: inline-flex; align-items: center; gap: 5px; color: var(--success); font-size: var(--fs-xs); font-weight: 500; }
.notify-problem { flex-basis: 100%; color: var(--danger); font-size: var(--fs-xs); }
@media (prefers-reduced-motion: reduce) { .live-dot, .mark-waiting { animation: none !important; } }

`;
