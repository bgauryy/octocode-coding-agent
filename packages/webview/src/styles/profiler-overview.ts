/** The Overview: KPI strip, agent rows with their context bars, Right now and Top findings. */
export const PROFILER_OVERVIEW_CSS = `/* Profiler overview */
.pf-cache-panel, .pf-cache-card, .pf-cache-usage { display: grid; gap: 12px; min-width: 0; }
.pf-cache-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 12px; }
.pf-cache-card { align-content: start; overflow-wrap: anywhere; }
.pf-cache-card p, .pf-cache-panel h3 { margin: 0; }
.pf-cache-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
.pf-cache-bar { display: flex; height: 22px; border-radius: 5px; overflow: hidden; background: var(--surface-3); }
.pf-cache-bar > span { display: block; height: 100%; }
.pf-ctx { display: grid; gap: 4px; min-width: 0; }
.pf-ctx-track { position: relative; display: block; height: 14px; border-radius: 4px; background: var(--surface-3); overflow: hidden; outline: 1px solid transparent; outline-offset: -1px; }
.pf-ctx-sm .pf-ctx-track { height: 10px; }
.pf-ctx.is-warn .pf-ctx-track { outline-color: var(--warning); }
.pf-ctx.is-danger .pf-ctx-track { outline: 2px solid var(--danger); outline-offset: -2px; }
.pf-ctx-fill { position: relative; display: flex; height: 100%; }
.pf-ctx-seg { display: block; height: 100%; min-width: 2px; box-shadow: inset -1px 0 0 var(--surface); }
.pf-ctx-buffer { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(135deg, var(--text-3) 0 2px, transparent 2px 6px); opacity: .35; }
.pf-ctx-tick { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: .7; }
.pf-ctx-text { font-size: var(--fs-xs); color: var(--text-2); font-variant-numeric: tabular-nums; }
.pf-ctx-warn { color: var(--danger); }
.pf-ctx-legend { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); color: var(--text-2); }
.pf-ctx-legend li { display: inline-flex; align-items: center; gap: 4px; }
.pf-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--pf-gap); margin: 0; padding: 0; list-style: none; }
.pf-kpi { display: grid; gap: 2px; width: 100%; padding: 12px 16px; text-align: start; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); cursor: pointer; }
.pf-kpi:hover { border-color: var(--accent-line); }
.pf-kpi[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line); }
.pf-kpi.is-warn { border-left-color: var(--warning); }
.pf-kpi.is-danger { border-left-color: var(--danger); }
.pf-kpi-label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); font-weight: 500; }
.pf-kpi-figure { font-size: var(--pf-fs-kpi); font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 1.2; }
.pf-kpi-sub { font-size: var(--fs-xs); color: var(--text-2); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-spark { display: inline-block; vertical-align: middle; color: var(--pf-cached); }
.pf-section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.pf-section-head h3 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
.pf-section-head .pf-controls { gap: 6px; }
.pf-agents { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.pf-agent { display: grid; gap: 4px; min-height: 64px; padding: 8px 12px 8px calc(12px + var(--depth, 0) * 20px); border-radius: var(--radius); border: 1px solid transparent; cursor: pointer; }
.pf-agent:hover { background: var(--surface-2); }
.pf-agent:focus-visible { outline-offset: -2px; }
.pf-agent.is-selected { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.pf-agent.is-ended { background: var(--surface-2); border: 1px dashed var(--border); color: var(--text-2); }
.pf-agent-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; }
.pf-agent-id { font-size: var(--fs-md); font-weight: 600; }
.pf-agent-sub { flex: 1 1 12ch; min-width: 0; font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-agent-stats { display: inline-flex; gap: 12px; margin-inline-start: auto; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.pf-chip { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: 999px; font-size: var(--fs-xs); font-weight: 500; background: var(--surface-3); color: var(--text-2); white-space: nowrap; }
.pf-chip.is-request { background: var(--accent-soft); color: var(--accent-strong); }
.pf-chip.is-tool { color: var(--tool); background: var(--surface-2); outline: 1px solid var(--border); }
.pf-chip.is-wait { color: var(--warning); background: var(--surface-2); outline: 1px solid var(--warning); }
.pf-timer { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.pf-cold { font-size: var(--fs-xs); color: var(--text-2); font-variant-numeric: tabular-nums; }
.pf-agent-legend { display: none; }
.pf-agent:hover .pf-agent-legend, .pf-agent.is-selected .pf-agent-legend { display: block; }
@media (min-width: 1400px) { .pf-agent-legend { display: block; } }
.pf-ended-toggle { margin-top: 8px; }
.pf-now { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pf-now li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: var(--fs-sm); }
.pf-now .pf-timer { margin-inline-start: auto; }
.pf-top { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.pf-top li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: var(--fs-sm); }
.pf-sev { padding: 0 6px; border-radius: var(--radius-sm); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; background: var(--surface-3); }
.pf-sev.is-high { color: var(--danger); outline: 1px solid var(--danger); background: var(--surface); }
.pf-sev.is-medium { color: var(--warning); outline: 1px solid var(--warning); background: var(--surface); }
.pf-kpis-skel { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--pf-gap); }
@media (max-width: 900px) {
.pf-agent-stats { margin-inline-start: 0; flex-basis: 100%; }
.pf-agent-legend { display: none !important; }
.pf-agent-line .pf-chip { flex-basis: 100%; width: fit-content; }
}
`;
