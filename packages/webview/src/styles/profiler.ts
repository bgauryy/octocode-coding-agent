import { PROFILER_DRAWER_CSS } from "./profiler-drawer.ts";
import { PROFILER_OVERVIEW_CSS } from "./profiler-overview.ts";

/** The profiler's shell, tokens (`--pf-*`) and the cache-state bars; the Overview and drawer styles join in. */
export const PROFILER_CSS =
	`/* Profiler */
:root { --pf-cached: var(--success); --pf-written: var(--tool); --pf-uncached: #b45309; --pf-short: var(--text-3); --pf-k-tools: var(--teal); --pf-k-system: var(--lav); --pf-k-message: #64748b; --pf-k-result: var(--coral); --pf-k-other: #a16207; --pf-k-output: var(--text-3); --pf-fs-kpi: clamp(22px, 1.1vw + 10px, 28px); --pf-gap: 12px; --pf-drawer: 380px; }
:root[data-theme="dark"] { --pf-uncached: #f2c14e; --pf-k-message: #94a3b8; --pf-k-other: #eab308; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --pf-uncached: #f2c14e; --pf-k-message: #94a3b8; --pf-k-other: #eab308; } }
.pf-g-tools { background: var(--pf-k-tools); }
.pf-g-system { background: var(--pf-k-system); }
.pf-g-history { background: var(--pf-k-message); }
.pf-g-result { background: var(--pf-k-result); }
.pf-g-other { background: var(--pf-k-other); }
.pf-g-output { background: var(--pf-k-output); }
.pf-g-free { background: var(--surface-3); border: 1px solid var(--border); }
.pf-num { font-variant-numeric: tabular-nums; font-family: var(--mono); color: var(--text); }
.pf-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; }
.profiler-view { width: 100%; max-width: none; display: grid; gap: var(--pf-gap); align-content: start; }
.profiler-view > *, #pf-panel { min-width: 0; }
.pf-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.pf-head h2 { margin: 0; font-size: var(--fs-xl); font-weight: 600; }
.pf-meta { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-2); }
.pf-controls { margin-inline-start: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pf-filter { width: 180px; max-width: 100%; }
.pf-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.pf-tab { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-2); font: inherit; font-size: var(--fs-sm); cursor: pointer; white-space: nowrap; }
.pf-tab:hover { color: var(--text); }
.pf-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.pf-count { padding: 0 6px; border-radius: 999px; background: var(--surface-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.pf-count.is-alert { background: var(--accent-soft); color: var(--accent-strong); }
.pf-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--pf-gap); align-items: start; }
.pf-body.has-drawer { grid-template-columns: minmax(0, 1fr) var(--pf-drawer); }
.pf-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 12px 16px; }
.pf-error { color: var(--danger); }
.pf-empty-block { display: grid; justify-items: center; max-width: 480px; margin: 48px auto; text-align: center; }
.pf-skel { display: block; background: var(--surface-3); border-radius: var(--radius-sm); animation: pf-pulse 1.4s ease-in-out infinite; }
@keyframes pf-pulse { 50% { opacity: .5; } }
.pf-detail-text { margin: 4px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 900px) { .pf-filter { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .pf-skel { animation: none; } }
.pf-findings { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.pf-finding { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.pf-timeline { min-width: 0; max-width: 100%; }
.pf-timeline-detail { margin-top: 8px; }

.pf-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); color: var(--text-2); }
.pf-legend li { display: inline-flex; align-items: center; gap: 4px; }
.pf-swatch { display: inline-block; width: 14px; height: 10px; border: 1px solid var(--text-2); border-radius: 2px; vertical-align: middle; }
.pf-cached { background: var(--pf-cached); }
.pf-written { background: repeating-linear-gradient(135deg, var(--pf-written) 0 3px, var(--surface) 3px 6px); }
.pf-uncached { background: radial-gradient(circle, var(--pf-uncached) 1.2px, transparent 1.6px) 0 0 / 5px 5px, var(--surface-3); }
.pf-too-short { background: var(--surface); border-style: dashed; }
.pf-seg.pf-too-short { border: 0; background: repeating-linear-gradient(90deg, var(--text-3) 0 2px, transparent 2px 6px); }

.pf-bar { display: block; height: 14px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
.pf-bar-fill { display: flex; height: 100%; }
.pf-seg { display: block; min-width: 1px; height: 100%; }
` +
	PROFILER_OVERVIEW_CSS +
	PROFILER_DRAWER_CSS;
