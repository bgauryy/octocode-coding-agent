/** The shared drawer: a side panel from 1100px, a bottom sheet below; agent, request, event and message content. */
export const PROFILER_DRAWER_CSS = `/* Profiler drawer */
.pf-drawer { position: sticky; top: 8px; display: grid; grid-template-rows: auto minmax(0, 1fr); max-height: calc(100vh - 16px); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); overflow: hidden; }
.pf-drawer-head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--border); }
.pf-drawer-head h3 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-md); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-drawer-body { display: grid; gap: 16px; align-content: start; padding: 12px 16px 16px; overflow: auto; min-width: 0; }
.pf-resize { position: absolute; inset: 0 auto 0 0; width: 6px; cursor: col-resize; background: transparent; border: 0; padding: 0; }
.pf-resize:hover, .pf-resize:focus-visible { background: var(--accent-line); }
.pf-card { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border-soft); border-radius: var(--radius); background: var(--surface-2); }
.pf-card h4 { margin: 0; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); font-weight: 500; }
.pf-table-lite { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.pf-table-lite th { text-align: start; font-size: var(--fs-xs); color: var(--text-2); font-weight: 500; padding: 2px 4px; }
.pf-table-lite td { padding: 2px 4px; border-top: 1px solid var(--border-soft); }
.pf-table-lite td:not(:first-child), .pf-table-lite th:not(:first-child) { text-align: end; }
.pf-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px 12px; margin: 0; }
.pf-facts dt { font-size: var(--fs-xs); color: var(--text-2); }
.pf-facts dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; overflow-wrap: anywhere; }
.pf-callout { margin: 0; padding: 8px 10px; border: 1px solid var(--warning); border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.pf-strip { display: flex; align-items: flex-end; gap: 2px; height: 40px; }
.pf-strip button { flex: 1 1 0; min-width: 3px; max-width: 14px; padding: 0; border: 0; border-radius: 2px 2px 0 0; background: var(--pf-k-message); cursor: pointer; }
.pf-strip button[aria-current="true"] { background: var(--accent); }
.pf-lbar { position: relative; display: grid; gap: 3px; }
.pf-lbar-main { display: flex; height: 18px; border-radius: 4px; overflow: hidden; background: var(--surface-3); }
.pf-lbar-main > span { display: block; min-width: 2px; height: 100%; box-shadow: inset -1px 0 0 var(--surface); }
.pf-lbar-cache { display: flex; height: 4px; border-radius: 2px; overflow: hidden; }
.pf-lbar-cache > span { display: block; height: 100%; }
.pf-lbar-ticks { position: absolute; inset: 0 0 auto 0; height: 18px; pointer-events: none; }
.pf-lbar-ticks i { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--text); }
.pf-llist { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.pf-llist li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 4px 6px; border-radius: var(--radius-sm); font-size: var(--fs-sm); }
.pf-llist li.is-break { background: var(--surface-2); box-shadow: inset 3px 0 0 var(--warning); }
.pf-llist .pf-lrow-bar { grid-column: 1 / -1; display: block; height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }
.pf-llist .pf-lrow-bar > span { display: block; height: 100%; }
.pf-layer-name { overflow-wrap: anywhere; }
.pf-layer-state { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); white-space: nowrap; }
.pf-layer-flags { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; }
.pf-layer-flags:empty { display: none; }
.pf-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
@media (max-width: 1100px) {
.pf-body.has-drawer { grid-template-columns: minmax(0, 1fr); }
.pf-drawer { position: fixed; inset: auto 0 0 0; top: auto; height: 60vh; max-height: 60vh; border-radius: var(--radius-lg) var(--radius-lg) 0 0; z-index: 20; box-shadow: var(--shadow-lg); }
.pf-resize { display: none; }
}
`;
