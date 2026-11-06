/** Board, table, tree and lists, the sheet. */
export const VIEWS_CSS = `/* Board */
.view-description { margin-top: 5px; font-size: var(--fs-sm); }
.board-overview { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; font-size: var(--fs-xs); color: var(--text-2); }
.board-overview strong { color: var(--text); font-variant-numeric: tabular-nums; }
.board-overview > span { padding: 5px 9px; background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
/* Compact desktop layout: a view's title and its filters share one row, and the lists start under it. */
.board-view, .backlog-view { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.board-view > *, .backlog-view > * { flex: 0 0 100%; min-width: 0; }
.board-view > .view-heading, .backlog-view > .view-heading { flex: 0 0 auto; }
.board-view > .toolbar, .backlog-view > .toolbar { flex: 1 1 0; padding: 2px; background: none; border: 0; border-radius: 0; }
.board-view .column-heading { padding: 8px 12px 6px; }
.board-view .column-description { display: none; }
.board-sort { margin-left: auto; }
.board-view .result-count, .backlog-view .result-count { margin-left: 0; }
.board { display: flex; gap: 16px; align-items: stretch; overflow-x: auto; padding: 2px 2px 16px; scroll-snap-type: x proximity; min-height: 52vh; }
.column { --lane: var(--state-backlog); display: flex; flex-direction: column; flex: 1 0 280px; min-width: 280px; max-height: calc(100vh - 270px); min-height: 240px; border-radius: var(--radius-lg); background: color-mix(in srgb, var(--surface-3) 58%, var(--bg)); border: 1px solid var(--border-soft); border-top: 3px solid var(--lane); scroll-snap-align: start; }
.column.state-todo { --lane: var(--tool); }
.column.state-ongoing { --lane: var(--state-ongoing); }
.column.state-done { --lane: var(--state-done); }
.column-heading { padding: 14px 12px 12px; }
.column-title { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); font-weight: 650; }
.column-title .count { margin-left: auto; background: var(--surface); }
.column-description { margin-top: 5px; color: var(--text-3); font-size: var(--fs-xs); }
.column-cards { display: grid; align-content: start; gap: 10px; padding: 0 9px 10px; overflow-y: auto; overscroll-behavior: contain; }
.column-empty { padding: 30px 8px; color: var(--text-3); font-size: var(--fs-xs); text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
.card { position: relative; display: grid; gap: 6px; padding: 9px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-sm); transition: border-color .12s, box-shadow .12s, transform .12s; }
.card[draggable=true] { cursor: grab; }
.card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); box-shadow: var(--shadow-md); }
.card:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
.card.is-dragging { opacity: .45; }
.card.is-lifted { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent), var(--shadow-md); transform: translateY(-2px); }
.card-main { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
.card-title { flex: 1; min-width: 0; font-size: var(--fs-md); font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.card-link { color: var(--text); }
.card-link::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
.card-link:hover { text-decoration: none; }
.card-link:focus-visible { outline: none; }
.card-closed { margin: 0; color: var(--text-3); font-size: var(--fs-xs); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; color: var(--text-3); font-size: var(--fs-xs); }
.card-meta > span { display: inline-flex; align-items: center; gap: 4px; }
.card-meta .badge { height: 18px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.card-meta .card-assignee { margin-left: auto; }
.priority-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: currentColor; color: var(--text-3); }
.priority-dot.priority-p2 { color: var(--accent); }
.chip { padding: 0 6px; border: 1px solid var(--border-soft); border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-variant-numeric: tabular-nums; font-weight: 600; }
.labels { display: flex; flex-wrap: wrap; gap: 4px; }
.label { --h: 210; max-width: 110px; padding: 0 7px; border: 1px solid color-mix(in srgb, hsl(var(--h) 70% 50%) 35%, transparent); border-radius: 4px; background: color-mix(in srgb, hsl(var(--h) 80% 50%) 16%, var(--surface)); color: color-mix(in srgb, hsl(var(--h) 75% 38%) 40%, var(--text)); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label-more { --h: 220; }
.tag-0 { --h: 210; } .tag-1 { --h: 150; } .tag-2 { --h: 32; } .tag-3 { --h: 280; } .tag-4 { --h: 350; } .tag-5 { --h: 180; } .tag-6 { --h: 55; } .tag-7 { --h: 320; }
.card-menu { position: relative; z-index: 1; flex-shrink: 0; }
.card-menu-button { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-2); font-size: var(--fs-xl); line-height: 1; cursor: pointer; }
.card-menu-button:hover, .card-menu-button[aria-expanded=true] { background: var(--surface-3); color: var(--text); }
.card-menu .menu { position: fixed; z-index: 40; display: grid; min-width: 190px; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-lg); }
.card-menu .menu > a, .card-menu .menu > button, .card-menu .menu > .menu-note { display: block; padding: 6px 10px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text); font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.card-menu .menu > a:hover, .card-menu .menu > button:hover, .card-menu .menu > :focus-visible { background: var(--surface-3); text-decoration: none; }
.card-menu .menu-note { color: var(--text-3); cursor: default; }
.menu-action { padding: 4px 6px; }
.menu-action .command { display: flex; flex-wrap: wrap; gap: 6px; }
.column.is-drop-target, .closed-drawer.is-drop-target { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 40%, var(--surface-2)); box-shadow: inset 0 0 0 2px var(--accent); }
.drop-indicator { padding: 14px 8px; border: 2px dashed var(--accent); border-radius: var(--radius); color: var(--accent); font-size: var(--fs-xs); font-weight: 600; text-align: center; }
.column-foot { padding: 0 9px 10px; }
.quick-add-open { width: 100%; padding: 7px 8px; border: 0; border-radius: var(--radius); background: none; color: var(--text-2); font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.quick-add-open:hover { background: var(--surface-3); color: var(--text); }
.quick-add { display: grid; gap: 4px; }
.quick-add input { min-height: 32px; font-size: var(--fs-sm); }
.closed-drawer { margin-top: 4px; border: 1px solid var(--border-soft); border-top: 3px solid var(--state-done); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--surface-3) 58%, var(--bg)); }
.closed-drawer-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 8px 12px; font-size: var(--fs-sm); font-weight: 650; }
.closed-drawer-title > button { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.closed-drawer-title .muted { font-weight: 400; font-size: var(--fs-xs); }
.closed-drawer .drop-indicator { margin: 0 12px 10px; }
.closed-list { display: grid; margin: 0; padding: 0 12px 10px; list-style: none; }
.closed-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding: 7px 0; border-top: 1px solid var(--border-soft); font-size: var(--fs-sm); }
.closed-reason { flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.popup { position: fixed; inset: 0; z-index: 41; margin: auto; width: min(440px, calc(100% - 24px)); height: fit-content; max-height: calc(100vh - 24px); overflow: auto; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg); }
.popup:focus { outline: none; }
.popup-body, .popup .close-item { display: grid; gap: 12px; padding: 16px 18px; }
.popup-body h3 { font-size: var(--fs-lg); }
.popup .actions { display: flex; gap: 8px; }
.toast { position: fixed; left: 50%; bottom: 20px; z-index: 50; display: flex; align-items: center; gap: 12px; max-width: min(560px, calc(100% - 24px)); padding: 10px 12px 10px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--text); color: var(--bg); box-shadow: var(--shadow-lg); font-size: var(--fs-sm); transform: translateX(-50%); }
.toast-error { border-color: var(--danger); }
.toast button { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.toast-action { font-weight: 700; text-decoration: underline; }
.toast-dismiss { font-size: var(--fs-xl); line-height: 1; }

/* Backlog planning queue */
.backlog-group { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.backlog-group-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 16px; padding: 12px 18px; background: var(--surface-2); border-bottom: 1px solid var(--border-soft); }
.backlog-group-heading h3 { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-md); }
.backlog-group-heading p { font-size: var(--fs-xs); }
.backlog-items { display: grid; margin: 0; padding: 0; list-style: none; }
.backlog-row { position: relative; display: flex; align-items: center; gap: 4px 12px; min-height: 40px; padding: 6px 12px 6px 18px; border-bottom: 1px solid var(--border-soft); }
.backlog-row:hover { background: color-mix(in srgb, var(--accent-soft) 24%, var(--surface)); }
.backlog-row:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
.backlog-row-title { flex: 1 1 240px; min-width: 0; overflow: hidden; color: var(--text); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.backlog-row-title::after { content: ""; position: absolute; inset: 0; }
.backlog-row .card-meta { flex: 0 1 auto; justify-content: flex-end; }
.backlog-row .card-menu { margin-left: auto; }
.backlog-empty { padding: 20px 18px; color: var(--text-3); font-size: var(--fs-sm); }
.backlog-foot { padding: 4px 12px 8px; }

/* Table */
.table-scroll { overflow: auto; max-height: calc(100vh - 220px); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.data-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-sm); }
.data-table th { position: sticky; top: 0; z-index: 1; padding: 0; background: var(--surface-2); border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
.data-table tbody tr:hover td { background: var(--surface-2); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.sort-button { display: inline-flex; align-items: center; gap: 4px; width: 100%; padding: 8px 12px; border: 0; background: none; color: var(--text-2); font: inherit; font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
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
.task-list { list-style: none; margin: 4px 0 4px 18px; padding: 0; display: grid; gap: 4px; }
.task-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.task-mark { display: inline-block; width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid currentColor; vertical-align: middle; }
.task-ongoing .task-mark { background: linear-gradient(90deg, transparent 50%, currentColor 50%); }
.task-done .task-mark { background: currentColor; }
.task-dropped .task-mark { border-style: dashed; }
.task-dropped .task-goal { text-decoration: line-through; color: var(--muted); }
.task-tools, .tree-tools, .state-control { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; }
.tree-tools { display: flex; margin: 4px 0 4px 18px; }
.task-tools select, .tree-tools select, .state-control select { min-height: 28px; font-size: var(--fs-xs); }
.task-tools .btn, .inline-add .btn { min-height: 28px; padding: 2px 8px; font-size: var(--fs-xs); }
.inline-add { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.inline-add input { min-width: 14ch; flex: 1; min-height: 28px; font-size: var(--fs-sm); }
.session-group h4 { margin: 10px 0 4px; font-size: var(--fs-sm); }
.session-group .task-list { margin-left: 0; }
.card-tasks { margin: 0; font-size: var(--fs-xs); }
.rollup { white-space: normal; }
.fold > summary, .disclosure > summary { cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); }
.fold[open] > summary { margin-bottom: 8px; }
.panel { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.panel-header { display: grid; gap: 4px; padding: 14px 16px; border-bottom: 1px solid var(--border-soft); }
.panel-header h2 { display: flex; align-items: center; gap: 8px; font-size: var(--fs-lg); font-weight: 600; }
.panel-header p { font-size: var(--fs-xs); }
.panel-empty { padding: 16px; }
.panel > .timeline { padding: 14px 16px 14px 20px; }
.row-list li { padding: 8px 16px; border-bottom: 1px solid var(--border-soft); }
.row-list li:last-child { border-bottom: 0; }
.row-reason { color: var(--text-3); font-size: var(--fs-xs); }
.related-list li, .plain-list li { padding: 3px 0; }

/* Docs library */
.docs-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0 16px; }
.docs-filters input[type="search"] { flex: 1 1 220px; }
.docs-topic { margin: 4px 0 12px; }
.doc-body { max-width: 860px; }
.diagram { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.diagram-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
.diagram-canvas { overflow: auto; text-align: center; }
.diagram-canvas svg { max-width: 100%; height: auto; }
.diagram-source { margin: 0; padding: 12px; max-height: 480px; overflow: auto; border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--fs-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.diagram-error { margin: 0 0 8px; color: var(--danger); font-size: var(--fs-sm); }

/* Sheet */
.backdrop { position: fixed; inset: 0; z-index: 20; background: rgb(13 17 23 / .45); animation: fade-in .15s var(--ease); }
.sheet { position: fixed; top: 8px; right: 8px; bottom: 8px; z-index: 21; width: min(760px, calc(100% - 16px)); overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); animation: slide-in .22s var(--ease); }
.sheet:focus { outline: none; }
.sheet-body, .editor { display: grid; gap: 16px; padding: 18px 28px 32px; }
.sheet-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; margin: -18px -28px 0; padding: 12px 20px 12px 28px; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border-soft); }
.sheet-bar h2 { font-size: var(--fs-lg); }
.push-right { margin-left: auto; }
.sheet-body > h2 { font-size: var(--fs-2xl); font-weight: 650; letter-spacing: -.015em; overflow-wrap: anywhere; }
.sheet-body > h2:focus { outline: none; }
.breadcrumbs { color: var(--text-3); font-size: var(--fs-xs); }
.sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.editor-fields { display: grid; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.properties { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); margin: 0; border: 1px solid var(--border-soft); border-radius: var(--radius); overflow: hidden; }
.property { display: grid; gap: 2px; padding: 8px 12px; box-shadow: 1px 1px 0 var(--border-soft); }
.property dt { color: var(--text-3); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.property dd { margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.section { display: grid; gap: 8px; }
.section-title { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.result { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--border-soft); border-radius: var(--radius); }
.result h4 { font-size: var(--fs-md); }
.timeline { display: grid; gap: 0; }
.timeline-entry { position: relative; display: grid; gap: 6px; padding: 0 0 16px 18px; border-left: 1px solid var(--border); margin-left: 4px; }
.timeline-entry::before { content: ""; position: absolute; left: -5px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
.timeline-entry.kind-change::before { border-color: var(--text-3); }
.timeline-entry:last-child { border-left-color: transparent; padding-bottom: 0; }
.timeline-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--fs-xs); }
.timeline-meta time { color: var(--text-3); }
.disclosure { padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius); }
.disclosure[open] > summary { margin-bottom: 12px; }
.disclosure > .field + .field, .disclosure > .field + .field-grid { margin-top: 12px; }
.editor { padding-top: 18px; }
.completion { display: grid; gap: 12px; margin: 0; padding: 12px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--accent-soft); }
.completion legend { padding: 0 6px; font-weight: 600; font-size: var(--fs-sm); color: var(--accent); }
.form-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.form-error { color: var(--danger); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.form-error:empty, .form-status:empty { display: none; }
.form-status { display: block; color: var(--text-2); font-size: var(--fs-xs); }

`;
