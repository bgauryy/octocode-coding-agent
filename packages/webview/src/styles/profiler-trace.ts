/** The profiler's Trace waterfall, Messages and Insights panels. Cache states use the `--pf-*` tokens of `profiler.ts`. */
export const PROFILER_TRACE_CSS = `/* Trace */
.pf-trace { display: grid; gap: 8px; min-width: 0; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); }
.pf-trace:focus-visible { outline-offset: -2px; }
.pf-t-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.pf-t-banner { display: grid; margin: 0; font-size: var(--fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
.pf-t-hint { font-size: var(--fs-xs); font-weight: 400; color: var(--text-2); }
.pf-t-buttons, .pf-t-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pf-t-chips { min-width: 0; margin: 0; padding: 0; border: 0; }
.pf-t-btn { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; font-size: var(--fs-xs); font-weight: 500; cursor: pointer; }
.pf-t-btn:hover { background: var(--surface-2); }
.pf-t-btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); }
.pf-t-live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--state-done); }
.pf-t-btn.is-live[aria-pressed="true"] .pf-t-live-dot { animation: pf-pulse 1.4s ease-in-out infinite; }
.pf-t-fchip { padding: 2px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-2); font: inherit; font-size: var(--fs-xs); cursor: pointer; }
.pf-t-fchip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); font-weight: 600; }
.pf-t-fchip.is-problems[aria-pressed="true"] { background: var(--surface-2); border-color: var(--danger); color: var(--danger); }
.pf-t-mini { min-width: 0; }
.pf-t-minimap { display: block; border-radius: var(--radius-sm); background: var(--surface-2); cursor: crosshair; touch-action: none; }
.pf-t-mini-bar { fill: var(--accent); opacity: .55; }
.pf-t-mini-dim { fill: var(--surface); opacity: .65; }
.pf-t-mini-brush { fill: var(--accent); fill-opacity: .1; stroke: var(--accent); }
.pf-t-body { display: grid; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.pf-t-gutter { border-inline-end: 1px solid var(--border); background: var(--surface); }
.pf-t-gutter-head { display: flex; align-items: center; padding-inline: 8px; font-size: var(--fs-xs); font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--text-2); border-bottom: 1px solid var(--border-soft); box-sizing: border-box; }
.pf-t-label { position: relative; display: flex; align-items: flex-start; justify-content: space-between; gap: 4px; box-sizing: border-box; padding-block: 4px; border-bottom: 1px solid var(--border-soft); }
.pf-t-label:nth-child(even) { background: var(--surface-2); }
.pf-t-label.is-selected { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.pf-t-label.is-ended { opacity: .75; }
.pf-t-lane-btn { display: grid; min-width: 0; flex: 1; gap: 2px; padding-block: 2px; padding-inline-end: 4px; border: 0; background: none; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.pf-t-lane-name { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); font-weight: 600; }
.pf-t-lane-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--text-2); }
.pf-t-status { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--state-pending); }
.pf-t-status.is-working { background: var(--state-running); }
.pf-t-lane-tools { display: flex; flex: none; align-items: center; gap: 2px; padding-inline-end: 4px; }
.pf-t-chip { padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); font-size: var(--fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
.pf-t-chip.is-warn { background: var(--surface-2); color: var(--warning); outline: 1px solid var(--warning); }
.pf-t-chip.is-danger { background: var(--surface-2); color: var(--danger); outline: 1px solid var(--danger); }
.pf-t-icon { padding: 0 4px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-2); font: inherit; font-size: var(--fs-sm); line-height: 1.4; cursor: pointer; }
.pf-t-icon:hover, .pf-t-icon[aria-pressed="true"] { color: var(--accent-strong); }
.pf-t-plot { position: relative; min-width: 0; overflow: hidden; }
.pf-t-plot svg { display: block; font-family: var(--font); }
.pf-t-lane { fill: var(--surface); }
.pf-t-lane.is-alt { fill: var(--surface-2); }
.pf-t-lane.is-selected { fill: var(--accent-soft); }
.pf-t-grid { stroke: var(--border-soft); }
.pf-t-tick { fill: var(--text-2); font-family: var(--mono); font-size: var(--fs-xs); }
.pf-t-cross { stroke: var(--text-3); stroke-dasharray: 3 3; }
.pf-t-now line { stroke: var(--accent); stroke-width: 1; }
.pf-t-now rect { fill: var(--accent); }
.pf-t-now text { fill: var(--on-accent); font-size: var(--fs-xs); font-weight: 600; }
.pf-t-p-cached { fill: var(--pf-cached); }
.pf-t-p-written-bg { fill: var(--surface); }
.pf-t-p-written { fill: var(--pf-written); }
.pf-t-p-uncached-bg { fill: var(--surface-3); }
.pf-t-p-uncached { fill: var(--pf-uncached); }
.pf-t-p-wait-bg { fill: var(--surface-2); }
.pf-t-p-wait { fill: var(--state-waiting); }
.pf-t-p-idle-bg { fill: var(--surface-2); }
.pf-t-p-idle { fill: var(--text-3); opacity: .5; }
.pf-t-kind { opacity: .9; }
.pf-t-k-request, .pf-t-k-compaction { fill: var(--accent); }
.pf-t-k-tool { fill: var(--tool); }
.pf-t-k-message { fill: var(--teal); }
.pf-t-k-notice, .pf-t-k-steer { fill: var(--text-3); }
.pf-t-outline { fill: none; stroke: var(--text-3); stroke-width: 1; }
.pf-t-outline.is-selected { stroke: var(--accent); stroke-width: 2.5; }
.pf-t-outline.is-evidence { stroke: var(--accent-strong); stroke-width: 2.5; stroke-dasharray: 4 2; }
.pf-t-outline.is-open { stroke: var(--accent); stroke-width: 1.5; }
.pf-t-outline.is-error { stroke: var(--danger); stroke-width: 2; }
.pf-t-outline.is-aborted { stroke: var(--state-stopped); stroke-dasharray: 4 2; }
.pf-t-item:focus-visible, .pf-t-marker:focus-visible { outline: none; }
.pf-t-item.is-focus .pf-t-outline { stroke: var(--accent); stroke-width: 2.5; }
.pf-t-edge { fill: var(--accent); animation: pf-pulse 1.4s ease-in-out infinite; }
.pf-t-break { fill: var(--danger); stroke: var(--surface); stroke-width: 1; }
.pf-t-bartext { fill: var(--text); font-size: var(--fs-xs); font-weight: 500; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
.pf-t-marker { cursor: pointer; }
.pf-t-marker circle { fill: var(--surface); stroke: var(--text-2); stroke-width: 1.5; }
.pf-t-marker[data-kind="interrupt"] circle { stroke: var(--state-stopped); }
.pf-t-marker.is-on circle { stroke: var(--accent); stroke-width: 3; }
.pf-t-marker text { fill: var(--text); font-size: var(--fs-xs); font-weight: 700; }
.pf-t-arrow { stroke: var(--teal); stroke-width: 1.5; }
.pf-t-arrow.is-answered { stroke: var(--state-done); }
.pf-t-arrow.is-awaiting-reply { stroke: var(--state-waiting); }
.pf-t-arrow.is-dead-lettered { stroke: var(--danger); }
.pf-t-arrow.is-queued { stroke: var(--text-2); }
.pf-t-arrow.is-selected { stroke: var(--accent); stroke-width: 3; }
.pf-t-ctx-track { fill: var(--surface-3); opacity: .6; }
.pf-t-ctx-area { fill: var(--pf-k-message); fill-opacity: .45; stroke: var(--pf-k-message); stroke-width: 1; }
.pf-t-ctx-compact { stroke: var(--warning); stroke-dasharray: 4 3; }
.pf-t-tip { position: absolute; z-index: 2; max-width: 280px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); box-shadow: var(--shadow-md); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; pointer-events: none; overflow-wrap: anywhere; }
.pf-t-tip-title { font-weight: 600; }
.pf-t-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); color: var(--text-2); }
.pf-t-legend li { display: inline-flex; align-items: center; gap: 5px; }
.pf-t-sw { display: inline-block; width: 14px; height: 10px; border: 1px solid var(--text-3); border-radius: 2px; }
.pf-t-sw-cached { background: var(--pf-cached); }
.pf-t-sw-written { background: repeating-linear-gradient(135deg, var(--pf-written) 0 3px, var(--surface) 3px 6px); }
.pf-t-sw-uncached { background: radial-gradient(circle, var(--pf-uncached) 1.3px, transparent 1.7px) 0 0 / 5px 5px, var(--surface-3); }
.pf-t-sw-wait { background: repeating-linear-gradient(135deg, var(--state-waiting) 0 3px, var(--surface-2) 3px 8px); }
.pf-t-sw-tool { background: var(--tool); }
@keyframes pf-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .pf-t-edge, .pf-t-btn.is-live .pf-t-live-dot { animation: none; } }
@media (max-width: 900px) { .pf-t-hint { display: none; } .pf-trace { padding: 8px; } }

/* Messages */
.pf-messages { display: grid; gap: 8px; min-width: 0; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); }
.pf-m-flow { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pf-m-pair { padding: 3px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); color: var(--text); font: inherit; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; cursor: pointer; }
.pf-m-pair.has-issue { border-color: var(--warning); }
.pf-m-pair[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); font-weight: 600; }
.pf-m-count { margin: 0; font-size: var(--fs-xs); }
.pf-m-scroll { max-height: 70vh; overflow: auto; }
.pf-m-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.pf-m-table th { position: sticky; top: 0; padding: 6px 8px; background: var(--surface-2); text-align: start; font-size: var(--fs-xs); font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--text-2); }
.pf-m-table td { padding: 6px 8px; border-top: 1px solid var(--border-soft); vertical-align: top; }
.pf-m-table tbody tr { min-height: 32px; cursor: pointer; outline: none; }
.pf-m-table tbody tr:hover { background: var(--surface-2); }
.pf-m-table tbody tr.is-selected { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.pf-m-table tbody tr.is-focus { box-shadow: inset 0 0 0 2px var(--accent); }
.pf-m-time, .pf-m-route, .pf-m-latency { white-space: nowrap; font-variant-numeric: tabular-nums; }
.pf-m-time { font-family: var(--mono); font-size: var(--fs-xs); }
.pf-m-text { width: 100%; overflow-wrap: anywhere; }
.pf-m-text pre { margin: 0; max-height: 320px; overflow: auto; font-family: inherit; white-space: pre-wrap; }
.pf-m-latency { color: var(--text-2); font-size: var(--fs-xs); }
.pf-m-wait { margin-inline-start: 6px; font-family: var(--mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--warning); }
.pf-m-scope { display: flex; align-items: center; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.pf-m-scope legend { float: left; padding: 0; margin-inline-end: 6px; font-size: var(--fs-xs); }
.pf-m-scope .pf-t-btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-strong); font-weight: 600; }
.pf-m-route { white-space: normal; }
.pf-end { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
.pf-end.is-departed .pf-end-name { color: var(--text-2); text-decoration: line-through; text-decoration-color: var(--border); }
.pf-mark { padding: 0 6px; border: 1px solid var(--border-soft); border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-size: var(--fs-xs); font-family: var(--mono); }
.pf-mark.is-departed, .pf-mark.is-warning { border-color: var(--warning); color: var(--warning); }
.pf-mark.is-danger { border-color: var(--danger); color: var(--danger); }
.pf-mark.is-internal { margin-inline-end: 6px; }
.pf-m-older { justify-self: start; }
.pf-tr h4 { margin: 0 0 6px; font-size: var(--fs-sm); }
.pf-tr-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.pf-tr-entry { padding: 6px 8px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.pf-tr-entry.is-near { border-color: var(--accent-line); }
.pf-tr-head { margin: 0 0 4px; font-size: var(--fs-xs); }
.pf-tr-text, .pf-tr-thinking { margin: 0; max-height: 320px; overflow: auto; font-family: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.pf-tr-thinking { color: var(--text-2); font-style: italic; }
.pf-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; background: var(--surface-3); color: var(--text-2); }
.pf-pill.is-tool { color: var(--tool); background: var(--surface-2); outline: 1px solid var(--tool); }
.pf-pill.is-warning { color: var(--warning); background: var(--surface-2); outline: 1px solid var(--warning); }
.pf-pill.is-success { color: var(--success); background: var(--surface-2); outline: 1px solid var(--success); }
.pf-pill.is-danger { color: var(--danger); background: var(--surface-2); outline: 1px solid var(--danger); }
@media (max-width: 900px) {
	.pf-m-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
	.pf-m-table tbody tr { display: grid; grid-template-columns: auto 1fr; grid-template-areas: "time state" "text text" "route latency"; align-items: center; }
	.pf-m-table td { border-top: 0; }
	.pf-m-time { grid-area: time; } .pf-m-text { grid-area: text; } .pf-m-route { grid-area: route; } .pf-m-latency { grid-area: latency; text-align: end; }
	.pf-m-table td:nth-child(3) { grid-area: state; text-align: end; }
}

/* Insights */
.pf-insights { display: grid; gap: 12px; min-width: 0; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); }
.pf-i-summary > summary { cursor: pointer; font-size: var(--fs-md); font-weight: 600; font-variant-numeric: tabular-nums; }
.pf-i-checks { display: grid; gap: 2px; margin: 8px 0 0; padding: 0; list-style: none; font-size: var(--fs-sm); color: var(--text-2); }
.pf-i-checks li span { color: var(--success); }
.pf-i-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.pf-i-row { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--border); border-inline-start: 3px solid var(--text-3); border-radius: var(--radius); background: var(--surface); }
.pf-i-row.is-high { border-inline-start-color: var(--danger); }
.pf-i-row.is-medium { border-inline-start-color: var(--warning); }
.pf-i-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 4px 10px; align-items: center; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.pf-i-title { font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; }
.pf-i-cost { font-size: var(--fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pf-i-agent { padding: 0 8px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); font-size: var(--fs-xs); font-family: var(--mono); }
.pf-i-detail { grid-column: 2 / -1; font-size: var(--fs-sm); color: var(--text-2); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.pf-i-evidence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; font-size: var(--fs-xs); }
.pf-i-group > details > summary { cursor: pointer; font-size: var(--fs-sm); font-weight: 600; margin-bottom: 8px; }
.pf-i-empty { margin: 0; }
.pf-pill.is-sev-high { color: var(--danger); background: var(--surface-2); outline: 1px solid var(--danger); text-transform: uppercase; }
.pf-pill.is-sev-medium { color: var(--warning); background: var(--surface-2); outline: 1px solid var(--warning); text-transform: uppercase; }
.pf-pill.is-sev-low { text-transform: uppercase; }
@media (max-width: 900px) { .pf-i-head { grid-template-columns: auto minmax(0, 1fr); } .pf-i-cost, .pf-i-agent { grid-column: 2; justify-self: start; } .pf-i-detail { grid-column: 1 / -1; } }
`;
