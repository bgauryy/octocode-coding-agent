/** Settings view: rows of a name, a value or state, and source badges. Colours come from the shared tokens. */
export const CONFIG_CSS = `/* Settings view */
.config-view { display: grid; gap: 16px; max-width: 880px; }
.config-view .view-actions { justify-content: space-between; }
.config-keychain { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.config-group > summary { display: flex; align-items: center; gap: 8px; padding: 10px 16px; cursor: pointer; border-bottom: 1px solid var(--border-soft); }
.config-group > summary h3 { font-size: 13px; font-weight: 600; }
.config-row { display: grid; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--border-soft); }
.row-list > .config-row:last-child { border-bottom: 0; }
.config-row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.config-name { font-weight: 600; overflow-wrap: anywhere; }
.config-sources { display: grid; gap: 4px; padding-left: 12px; }
.config-source { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.config-source .badge code { font-size: 11px; }
.config-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.config-edit input { flex: 1 1 200px; min-width: 0; padding: 6px 10px; }
.config-edit select, .panel-header select { padding: 6px 10px; max-width: 100%; }
.config-edit > p { flex-basis: 100%; margin: 0; }
.config-methods { margin: 0; font-size: 12px; }
.config-signin { display: grid; gap: 6px; }
.config-signin-live { display: grid; gap: 6px; }
.config-signin p { margin: 0; overflow-wrap: anywhere; }
.panel > .callout { margin: 12px 16px 0; }
@media (forced-colors: active) { .config-row { border-bottom-color: CanvasText; } }
`;
