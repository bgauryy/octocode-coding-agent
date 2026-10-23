/** Board, table, tree and lists, the sheet. */
export const VIEWS_CSS = `/* Board */
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

`;
