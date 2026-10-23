/** Controls, badges, avatars, status, shell and header. */
export const CHROME_CSS = `/* Controls */
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

`;
