/**
 * Octocode design tokens, shared with the terminal themes (`coding-agent/src/modes/interactive/theme/octocode-*.json`):
 * purple accent, GitHub-like neutrals, and status colors. Colors identify state; tags and metadata stay neutral.
 */
export const PAGE_CSS = `
:root {
	color-scheme: light dark;
	--bg: #f6f8fa; --surface: #ffffff; --surface-2: #f6f8fa; --surface-3: #eaeef2;
	--border: #d0d7de; --border-soft: #eaeef2;
	--text: #24292f; --text-2: #4b5563; --text-3: #667085;
	--accent: #6d28d9; --accent-strong: #5b21b6; --accent-soft: #f3e8ff; --accent-line: #ddd6fe; --on-accent: #ffffff;
	--success: #15803d; --danger: #b91c1c; --warning: #b45309; --tool: #0369a1; --agent: #6d28d9; --teal: #0d9488; --coral: #c2410c; --lav: #4f46e5;
	--state-backlog: #8c959f; --state-todo: #4b5563; --state-ongoing: #b45309; --state-done: #15803d;
	--shadow-sm: 0 1px 2px rgb(31 35 40 / .06); --shadow-md: 0 4px 12px rgb(31 35 40 / .08); --shadow-lg: 0 24px 64px rgb(31 35 40 / .22);
	--radius-sm: 6px; --radius: 8px; --radius-lg: 12px;
	--font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
	--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
	--ease: cubic-bezier(.2, .8, .2, 1);
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0d1117; --surface: #161b22; --surface-2: #1c2128; --surface-3: #21262d;
		--border: #30363d; --border-soft: #21262d;
		--text: #e6edf3; --text-2: #a7b0bc; --text-3: #8b949e;
		--accent: #c084fc; --accent-strong: #a78bfa; --accent-soft: #1a1426; --accent-line: #3b2a5c; --on-accent: #0d1117;
		--success: #56d364; --danger: #ff6b6b; --warning: #f2c14e; --tool: #7dd3fc; --agent: #c084fc; --teal: #5eead4; --coral: #ff8a65; --lav: #a5b4fc;
		--state-backlog: #6e7681; --state-todo: #a7b0bc; --state-ongoing: #f2c14e; --state-done: #56d364;
		--shadow-sm: 0 1px 2px rgb(0 0 0 / .3); --shadow-md: 0 4px 12px rgb(0 0 0 / .35); --shadow-lg: 0 24px 64px rgb(0 0 0 / .6);
	}
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
code, kbd, pre { font-family: var(--mono); }
code { font-size: 12px; overflow-wrap: anywhere; }
h1, h2, h3, h4 { margin: 0; line-height: 1.25; }
ul, ol { margin: 0; padding: 0; list-style: none; }
p { margin: 0; }
/* Open dialogs are positioned and styled by their component class; drop the user-agent dialog box. */
dialog { inset: auto; width: auto; height: auto; margin: 0; padding: 0; border: 0; background: none; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
::selection { background: var(--accent-soft); }
.icon { flex-shrink: 0; }
.muted { color: var(--text-2); overflow-wrap: anywhere; }
.nowrap { white-space: nowrap; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.ref { font-family: var(--mono); font-size: 12px; color: var(--text-3); font-weight: 500; white-space: nowrap; }
a.ref { color: var(--text-2); }
.count { display: inline-grid; place-items: center; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); font-size: 11px; font-weight: 600; }
.kbd { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; background: var(--surface); color: var(--text-3); font-size: 10px; font-weight: 600; line-height: 1; }

/* Controls */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: background .12s, border-color .12s, color .12s, box-shadow .12s; }
.btn:hover:not(:disabled) { background: var(--surface-2); border-color: var(--text-3); }
.btn:active:not(:disabled) { transform: translateY(.5px); }
.btn:disabled { cursor: default; opacity: .55; }
.btn-sm { min-height: 28px; padding: 3px 9px; font-size: 12px; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); box-shadow: var(--shadow-sm); }
.btn-primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--text-2); }
.btn-ghost:hover:not(:disabled) { background: var(--surface-3); border-color: transparent; color: var(--text); }
.btn-danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 10%, var(--surface)); border-color: var(--danger); }
.btn-icon { width: 30px; min-height: 30px; padding: 0; }
.btn[aria-pressed=true] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent); }
input, select, textarea { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); transition: border-color .12s, box-shadow .12s; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
input::placeholder, textarea::placeholder { color: var(--text-3); }
input:disabled, select:disabled, textarea:disabled { opacity: .6; }
select { min-height: 34px; padding: 4px 28px 4px 10px; font-size: 13px; cursor: pointer; }
.filter-select { min-height: 30px; font-size: 12px; color: var(--text-2); }
.filter-select.is-active { border-color: var(--accent-line); background-color: var(--accent-soft); color: var(--accent); font-weight: 500; }
.search-field { position: relative; display: flex; align-items: center; flex: 1 1 220px; max-width: 360px; }
.search-field > .icon { position: absolute; left: 10px; color: var(--text-3); pointer-events: none; }
.search-field input { width: 100%; min-height: 32px; padding: 5px 34px 5px 32px; font-size: 13px; }
.search-field .kbd { position: absolute; right: 8px; pointer-events: none; }
.field { display: grid; gap: 6px; min-width: 0; }
.field > label { font-size: 12px; font-weight: 600; color: var(--text-2); }
.field input, .field textarea, .field select { width: 100%; padding: 8px 10px; }
.field textarea { min-height: 64px; resize: vertical; line-height: 1.5; }
.field-hint { font-size: 12px; color: var(--text-3); }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.segmented { margin: 0; min-width: 0; display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.segmented button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 10px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-2); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.segmented button:hover { color: var(--text); }
.segmented button[aria-pressed=true] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm), 0 0 0 1px var(--border); }

/* Badges, avatars, status */
.badge { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--tone) 10%, var(--surface)); color: var(--tone); font-size: 11px; font-weight: 600; white-space: nowrap; }
.tone-neutral { --tone: var(--text-2); } .tone-accent { --tone: var(--accent); } .tone-success { --tone: var(--success); }
.tone-warning { --tone: var(--warning); } .tone-danger { --tone: var(--danger); } .tone-tool { --tone: var(--tool); } .tone-agent { --tone: var(--agent); }
.avatar { display: inline-grid; place-items: center; width: 22px; height: 22px; flex-shrink: 0; border-radius: 50%; background: var(--surface-3); color: var(--text); font-size: 9px; font-weight: 700; letter-spacing: .02em; }
.status-icon { flex-shrink: 0; }
.state-backlog .status-icon, .status-icon.state-backlog { color: var(--state-backlog); }
.state-todo .status-icon, .status-icon.state-todo { color: var(--state-todo); }
.state-ongoing .status-icon, .status-icon.state-ongoing { color: var(--state-ongoing); }
.state-done .status-icon, .status-icon.state-done { color: var(--state-done); }
.status-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.priority-icon { flex-shrink: 0; color: var(--text-3); }
.priority-p0 { color: var(--danger); } .priority-p1 { color: var(--coral); }
.priority-cell { display: inline-flex; align-items: center; gap: 6px; }
.live-dot { display: inline-block; width: 7px; height: 7px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
.live-dot:not(.is-paused) { animation: pulse 1.8s var(--ease) infinite; }
.live-dot.is-paused { background: var(--text-3); animation: none; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.empty-state { display: grid; justify-items: center; gap: 6px; padding: 40px 20px; text-align: center; color: var(--text-2); }
.empty-icon { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: 6px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.empty-title { color: var(--text); font-weight: 600; }
.empty-text { max-width: 44ch; font-size: 13px; }
.callout { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent); border-radius: var(--radius); background: color-mix(in srgb, var(--tone) 8%, var(--surface)); color: var(--text); font-size: 13px; }
.callout p + p { margin-top: 4px; }

/* Shell and header */
.shell { min-height: 100vh; }
header.top { position: sticky; top: 0; z-index: 5; padding: 14px 28px 0; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--border); }
.header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.brand-mark { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, var(--accent), var(--teal)); }
.brand-sep { color: var(--text-3); font-weight: 400; }
.header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.palette-trigger { display: inline-flex; align-items: center; gap: 8px; min-width: 220px; min-height: 32px; padding: 4px 8px 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-3); font: inherit; font-size: 13px; cursor: pointer; }
.palette-trigger span:not(.kbd) { flex: 1; text-align: left; }
.palette-trigger:hover { border-color: var(--text-3); color: var(--text-2); }
.connection { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; height: 26px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--tone); background: color-mix(in srgb, var(--tone) 10%, transparent); }
.connection.tone-live { --tone: var(--success); } .connection.tone-connecting { --tone: var(--warning); } .connection.tone-error { --tone: var(--danger); }
.connection.tone-error .live-dot { animation: none; }
.title-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 14px; }
h1 { font-size: 22px; font-weight: 650; letter-spacing: -.02em; overflow-wrap: anywhere; }
.progress-summary { display: flex; align-items: center; gap: 10px; margin-left: auto; color: var(--text-2); font-size: 12px; }
.progress { width: 96px; height: 6px; border: 0; border-radius: 999px; overflow: hidden; background: var(--surface-3); accent-color: var(--accent); }
.progress::-webkit-progress-bar { background: var(--surface-3); }
.progress::-webkit-progress-value { background: var(--accent); border-radius: 999px; }
.progress::-moz-progress-bar { background: var(--accent); }
.snapshot-info { margin-top: 6px; color: var(--text-3); font-size: 12px; }
.snapshot-info summary { width: fit-content; cursor: pointer; }
.snapshot-info p { margin: 8px 0; }
.stats { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 8px; }
.stat { display: flex; gap: 6px; }
.stat dt { color: var(--text-3); }
.stat dd { margin: 0; color: var(--text); font-weight: 600; }
nav.tabs { display: flex; gap: 2px; margin-top: 10px; overflow-x: auto; scrollbar-width: none; }
.tab { position: relative; display: inline-flex; align-items: center; gap: 7px; padding: 9px 12px 11px; color: var(--text-2); font-size: 13px; font-weight: 500; white-space: nowrap; border-radius: var(--radius-sm) var(--radius-sm) 0 0; }
.tab:hover { color: var(--text); background: var(--surface-3); text-decoration: none; }
.tab.active { color: var(--text); }
.tab.active::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
.tab.active .icon { color: var(--accent); }
.tab-badge { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--danger) 14%, var(--surface)); color: var(--danger); font-size: 11px; font-weight: 700; }
main { padding: 20px 28px 48px; }
.view { display: grid; gap: 16px; min-width: 0; }
.view-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
.view-heading h2 { font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.result-count { margin-left: auto; color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }

/* Board */
.board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding: 2px 2px 16px; scroll-snap-type: x proximity; min-height: 58vh; }
.column { display: flex; flex-direction: column; flex: 1 0 280px; min-width: 280px; max-height: calc(100vh - 220px); border-radius: var(--radius-lg); background: var(--surface-2); border: 1px solid var(--border-soft); scroll-snap-align: start; }
.column-title { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; font-size: 13px; font-weight: 600; }
.column-title .count { margin-left: auto; }
.column-cards { display: grid; gap: 8px; padding: 0 8px 8px; overflow-y: auto; }
.column-empty { padding: 24px 8px; color: var(--text-3); font-size: 12px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
.card { position: relative; display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-sm); transition: border-color .12s, box-shadow .12s, transform .12s; content-visibility: auto; contain-intrinsic-size: auto 120px; }
.card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); box-shadow: var(--shadow-md); }
.card:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
.card-top { display: flex; align-items: center; gap: 6px; }
.card-top .priority-icon { margin-left: auto; }
.card-title { font-size: 14px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.card-link { color: var(--text); }
.card-link::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
.card-link:hover { text-decoration: none; }
.card-link:focus-visible { outline: none; }
.card-goal { color: var(--text-2); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.card-flags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
.labels { display: flex; flex-wrap: wrap; gap: 4px; }
.label { max-width: 100%; padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-2); font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; color: var(--text-3); font-size: 11px; }
.card-meta > span { display: inline-flex; align-items: center; gap: 3px; }
.card-meta .avatar { margin-left: auto; }

/* Table */
.table-scroll { overflow: auto; max-height: calc(100vh - 220px); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.data-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.data-table th { position: sticky; top: 0; z-index: 1; padding: 0; background: var(--surface-2); border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
.data-table tbody tr:hover td { background: var(--surface-2); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.sort-button { display: inline-flex; align-items: center; gap: 4px; width: 100%; padding: 8px 12px; border: 0; background: none; color: var(--text-2); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.sort-button:hover, th[aria-sort=ascending] .sort-button, th[aria-sort=descending] .sort-button { color: var(--text); }
th.num .sort-button { justify-content: flex-end; }
td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-2); }
.title-cell { min-width: 22em; overflow-wrap: anywhere; }
.title-cell a { color: var(--text); font-weight: 500; }
.truncate { max-width: 16em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assignee { display: inline-flex; align-items: center; gap: 6px; }
.table-empty { padding: 32px 12px !important; color: var(--text-3); text-align: center; }

/* Tree, lists */
.item-line { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; padding: 3px 0; }
.item-line-title { color: var(--text); overflow-wrap: anywhere; }
.item-line.state-done .item-line-title { color: var(--text-3); text-decoration: line-through; }
.tree { padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.tree ul ul { margin-left: 8px; padding-left: 14px; border-left: 1px solid var(--border); }
.tree details > summary { cursor: pointer; padding: 2px 0; }
.tree .leaf { padding-left: 18px; }
.tree-alone { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-soft); }
.fold > summary, .disclosure > summary { cursor: pointer; color: var(--text-2); font-size: 13px; }
.fold[open] > summary { margin-bottom: 8px; }
.panel { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.panel-header { display: grid; gap: 4px; padding: 14px 16px; border-bottom: 1px solid var(--border-soft); }
.panel-header h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
.panel-header p { font-size: 12px; }
.panel-empty { padding: 16px; }
.panel > .timeline { padding: 14px 16px 14px 20px; }
.row-list li { padding: 8px 16px; border-bottom: 1px solid var(--border-soft); }
.row-list li:last-child { border-bottom: 0; }
.row-reason { color: var(--text-3); font-size: 12px; }
.related-list li, .plain-list li { padding: 3px 0; }

/* Sheet */
.backdrop { position: fixed; inset: 0; z-index: 20; background: rgb(13 17 23 / .45); animation: fade-in .15s var(--ease); }
.sheet { position: fixed; top: 8px; right: 8px; bottom: 8px; z-index: 21; width: min(760px, calc(100% - 16px)); overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); animation: slide-in .22s var(--ease); }
.sheet:focus { outline: none; }
.sheet-body, .editor { display: grid; gap: 16px; padding: 18px 28px 32px; }
.sheet-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; margin: -18px -28px 0; padding: 12px 20px 12px 28px; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border-soft); }
.sheet-bar h2 { font-size: 15px; }
.push-right { margin-left: auto; }
.sheet-body > h2 { font-size: 22px; font-weight: 650; letter-spacing: -.015em; overflow-wrap: anywhere; }
.sheet-body > h2:focus { outline: none; }
.breadcrumbs { color: var(--text-3); font-size: 12px; }
.sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.properties { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); margin: 0; border: 1px solid var(--border-soft); border-radius: var(--radius); overflow: hidden; }
.property { display: grid; gap: 2px; padding: 8px 12px; box-shadow: 1px 1px 0 var(--border-soft); }
.property dt { color: var(--text-3); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.property dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.section { display: grid; gap: 8px; }
.section-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text); }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.result { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--border-soft); border-radius: var(--radius); }
.result h4 { font-size: 14px; }
.timeline { display: grid; gap: 0; }
.timeline-entry { position: relative; display: grid; gap: 6px; padding: 0 0 16px 18px; border-left: 1px solid var(--border); margin-left: 4px; }
.timeline-entry::before { content: ""; position: absolute; left: -5px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
.timeline-entry.kind-change::before { border-color: var(--text-3); }
.timeline-entry:last-child { border-left-color: transparent; padding-bottom: 0; }
.timeline-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.timeline-meta time { color: var(--text-3); }
.disclosure { padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius); }
.disclosure[open] > summary { margin-bottom: 12px; }
.disclosure > .field + .field, .disclosure > .field + .field-grid { margin-top: 12px; }
.editor { padding-top: 18px; }
.completion { display: grid; gap: 12px; margin: 0; padding: 12px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--accent-soft); }
.completion legend { padding: 0 6px; font-weight: 600; font-size: 13px; color: var(--accent); }
.form-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.form-error { color: var(--danger); font-size: 13px; }
.form-error:empty, .form-status:empty { display: none; }
.form-status { display: block; color: var(--text-2); font-size: 12px; }

/* Command palette */
.palette-backdrop { background: rgb(13 17 23 / .35); z-index: 30; }
.palette { position: fixed; top: 12vh; left: 50%; z-index: 31; display: flex; flex-direction: column; width: min(640px, calc(100% - 24px)); max-height: 70vh; transform: translateX(-50%); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); overflow: hidden; animation: pop-in .16s var(--ease); }
.palette-input { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border-soft); color: var(--text-3); }
.palette-input input { flex: 1; min-width: 0; border: 0; background: none; padding: 4px 0; font-size: 15px; box-shadow: none; }
.palette-list { overflow-y: auto; padding: 6px; }
.palette-group { padding: 8px 10px 4px; color: var(--text-3); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.palette-option { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; }
.palette-option.is-active { background: var(--accent-soft); color: var(--text); }
.palette-option.is-active .palette-icon { color: var(--accent); }
.palette-icon { display: grid; place-items: center; width: 18px; color: var(--text-3); }
.palette-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-hint { font-family: var(--mono); font-size: 11px; color: var(--text-3); }
.palette-empty { padding: 24px; text-align: center; color: var(--text-3); }
.palette-footer { display: flex; gap: 16px; padding: 8px 14px; border-top: 1px solid var(--border-soft); color: var(--text-3); font-size: 11px; }
.palette-footer span { display: inline-flex; align-items: center; gap: 4px; }

/* Live: activity, session, agents */
.activity-view, .agents-view, .audit-view { max-width: 1040px; width: 100%; margin-inline: auto; }
.overview { display: flex; flex-wrap: wrap; align-items: stretch; gap: 10px; }
.metric { display: grid; gap: 2px; min-width: 140px; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); }
a.metric:hover { border-color: var(--accent-line); text-decoration: none; }
.metric strong { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
.metric span { color: var(--text-2); font-size: 12px; }
.overview > p { align-self: center; font-size: 12px; }
.session-panel { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--accent-line); border-radius: var(--radius-lg); background: linear-gradient(180deg, var(--accent-soft), var(--surface) 70%); }
.session-panel-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.session-panel-header h3 { font-size: 14px; font-weight: 600; }
.composer { display: grid; gap: 10px; min-width: 0; }
.composer-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.composer-actions > .field { flex: 1 1 200px; }
.composer-actions > .btn { min-height: 36px; }
.queue-chips, .receipts li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
.receipts { display: grid; gap: 6px; }
.feed-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.feed-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.feed-status .live-dot { color: var(--success); }
.activity-feed { display: grid; gap: 10px; }
.result-card { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-left: 3px solid var(--tone); border-radius: var(--radius); background: var(--surface); overflow-wrap: anywhere; content-visibility: auto; contain-intrinsic-size: auto 160px; }
.result-card.is-compact { padding: 10px 12px; gap: 6px; border-left-width: 2px; box-shadow: none; }
.result-card h3 { font-size: 15px; font-weight: 600; line-height: 1.45; }
.result-card.is-compact h3 { font-family: var(--mono); font-size: 13px; font-weight: 500; }
.result-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.result-meta time { margin-left: auto; color: var(--text-3); font-variant-numeric: tabular-nums; }
.streaming-label { color: var(--accent); font-weight: 600; }
.is-streaming .markdown-body > :last-child:not(ul, ol, pre, div, table)::after, .is-streaming .markdown-body > :is(ul, ol):last-child > li:last-child::after { content: "▍"; margin-left: 2px; color: var(--accent); animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }
.result-files { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius); background: var(--surface-2); font-size: 12px; }
.result-files ul { display: flex; flex-wrap: wrap; gap: 6px; }
.result-files code { padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }
.result-details { color: var(--text-3); font-size: 12px; }
.result-details summary { cursor: pointer; }
.result-details pre { max-height: 320px; margin: 8px 0 0; padding: 10px; overflow: auto; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); font-size: 12px; }
.tool-group { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.tool-group.has-failure { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.tool-group > summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; font-size: 13px; list-style: none; }
.tool-group > summary::-webkit-details-marker { display: none; }
.tool-group > summary::after { content: ""; width: 7px; height: 7px; margin-left: auto; border-right: 1.5px solid var(--text-3); border-bottom: 1.5px solid var(--text-3); transform: rotate(-45deg); transition: transform .15s var(--ease); }
.tool-group[open] > summary::after { transform: rotate(45deg); }
.tool-group-title { font-weight: 600; }
.tool-group-icon { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; }
.tool-group-icon.is-done { color: var(--success); }
.tool-group-icon.is-failed { color: var(--danger); }
.tool-group-icon.is-running { border: 2px solid var(--accent-line); border-top-color: var(--accent); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.tool-group-list { display: grid; gap: 6px; padding: 0 10px 10px; }
.agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.agent-card { display: grid; gap: 10px; align-content: start; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.agent-card.is-working { border-color: var(--accent-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 8%, transparent); }
.agent-card-header { display: flex; align-items: flex-start; gap: 10px; }
.agent-card-header > div { flex: 1; min-width: 0; }
.agent-card-header h3 { font-size: 14px; font-family: var(--mono); font-weight: 600; }
.agent-card-header p { font-size: 12px; }
.agent-avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.agent-goal { font-size: 13px; }
.agent-activity, .agent-usage { font-size: 12px; }
.command-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.command { display: grid; gap: 4px; align-content: start; }
.command .btn { width: 100%; }
.audit-rows { display: grid; gap: 6px; }
.audit-entry { padding: 8px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--surface); font-size: 13px; }
.audit-entry summary { cursor: pointer; }
.diff { display: grid; gap: 4px; margin: 8px 0 0; }
.diff > div { display: grid; grid-template-columns: minmax(80px, max-content) 1fr; gap: 10px; }
.diff dt { color: var(--text-3); font-family: var(--mono); font-size: 12px; }
.diff dd { margin: 0; overflow-wrap: anywhere; }
.diff-before { color: var(--danger); text-decoration: line-through; text-decoration-thickness: 1px; }
.diff-after { color: var(--success); }

/* Markdown and code */
.markdown-view { display: grid; gap: 6px; min-width: 0; }
.markdown-toolbar, .code-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.markdown-toolbar { justify-content: flex-end; margin-bottom: -4px; opacity: .6; transition: opacity .12s; }
.markdown-view:hover .markdown-toolbar, .markdown-toolbar:focus-within { opacity: 1; }
.text.output { padding: 8px 10px; border-radius: var(--radius-sm); background: var(--surface-2); font: 12px/1.55 var(--mono); max-height: 320px; overflow: auto; }
.markdown-body { font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.markdown-body > * + * { margin-top: 10px; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { font-size: 16px; font-weight: 650; margin-top: 18px; }
.markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 14px; font-weight: 650; margin-top: 14px; }
.markdown-body ul, .markdown-body ol { padding-left: 22px; }
.markdown-body ul { list-style: disc; } .markdown-body ol { list-style: decimal; }
.markdown-body li::marker { color: var(--accent); }
.markdown-body blockquote { margin: 0; padding: 4px 14px; border-left: 3px solid var(--accent-line); color: var(--text-2); }
.markdown-body a { text-decoration: underline; text-underline-offset: 2px; }
.markdown-body :not(pre) > code { padding: 1px 5px; border-radius: 4px; background: var(--surface-3); color: var(--tool); }
.markdown-body table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown-body th, .markdown-body td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; }
.markdown-body th { background: var(--surface-2); }
.markdown-body hr { border: 0; border-top: 1px solid var(--border); }
.markdown-source { margin: 0; padding: 12px; max-height: 600px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.code-view { margin-top: 10px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.code-toolbar { padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--border-soft); }
.code-language { margin-right: auto; color: var(--text-3); font: 11px var(--mono); }
.code-view pre { margin: 0; padding: 12px 14px; max-height: 480px; overflow: auto; white-space: pre; line-height: 1.6; font-size: 12.5px; }
.code-view pre code { font-size: inherit; }
.code-view pre.wrap-code { white-space: pre-wrap; overflow-wrap: anywhere; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal { color: var(--coral); }
.hljs-title, .hljs-title.function_, .hljs-section { color: var(--lav); }
.hljs-string, .hljs-addition, .hljs-attr { color: var(--success); }
.hljs-number, .hljs-built_in, .hljs-type { color: var(--warning); }
.hljs-variable, .hljs-property { color: var(--tool); }
.hljs-deletion { color: var(--danger); }
.hljs-comment, .hljs-meta { color: var(--text-3); font-style: italic; }

/* Loaders and run state */
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
.run-indicator { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--accent-soft); font-size: 13px; font-weight: 500; }
.run-orb { position: relative; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.run-orb::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--accent); opacity: 0; animation: ping 1.6s var(--ease) infinite; }
.phase-tool .run-orb { background: var(--teal); } .phase-tool .run-orb::after { border-color: var(--teal); }
@keyframes ping { 0% { transform: scale(.6); opacity: .7; } 100% { transform: scale(1.6); opacity: 0; } }
.shimmer { background: linear-gradient(90deg, var(--text-2) 0%, var(--text) 40%, var(--accent) 50%, var(--text) 60%, var(--text-2) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer-text 2.2s linear infinite; }
@keyframes shimmer-text { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.run-elapsed, .elapsed { color: var(--text-3); font-variant-numeric: tabular-nums; font-weight: 400; }
.run-elapsed { margin-left: auto; }
.thought-for { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); font-size: 12px; font-weight: 500; }

/* File edit diffs */
.diff-view { display: grid; gap: 8px; }
.diff-file { margin: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); }
.diff-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border-soft); background: var(--surface-2); font-size: 12px; }
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
.terminal-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-bottom: 1px solid #21262d; background: #161b22; color: var(--term-dim); font-size: 12px; }
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
.terminal-status { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: var(--term-dim); font-size: 11px; }
.status-done .terminal-status { color: var(--term-ok); }
.status-failed .terminal-status { color: var(--term-bad); }
.status-failed .prompt-symbol { color: var(--term-bad); }
.status-running .terminal-status { color: var(--term-warn); }
.terminal-output { margin: 0; padding-left: 18px; color: #c9d1d9; white-space: pre; }
.terminal-body.is-wrapped .terminal-output { white-space: pre-wrap; overflow-wrap: anywhere; }
.terminal-empty { place-items: center; padding: 48px 16px; text-align: center; font-family: var(--font); }
.terminal-muted { color: var(--term-dim); font-size: 13px; }
.terminal-jump { position: absolute; right: 16px; bottom: 14px; box-shadow: var(--shadow-md); }

@keyframes fade-in { from { opacity: 0; } }
@keyframes slide-in { from { opacity: 0; transform: translateX(24px); } }
@keyframes pop-in { from { opacity: 0; transform: translate(-50%, -6px) scale(.98); } }

@media (max-width: 720px) {
	header.top { padding: 12px 16px 0; }
	main { padding: 16px 16px 40px; }
	.palette-trigger { min-width: 0; flex: 1; }
	.palette-trigger span:not(.kbd), .palette-trigger .kbd { display: none; }
	.progress-summary { margin-left: 0; }
	.board { margin-right: -16px; padding-right: 16px; }
	.column { flex: 0 0 85vw; min-width: 0; max-height: none; }
	.search-field { flex-basis: 100%; max-width: none; }
	.result-count { margin-left: 0; }
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
	.live-dot, .status-icon, .priority-icon { forced-color-adjust: auto; }
}
@media print {
	header.top { position: static; backdrop-filter: none; }
	.board { flex-wrap: wrap; overflow: visible; }
	.backdrop, .palette, .palette-trigger, .header-actions { display: none !important; }
}
`;
