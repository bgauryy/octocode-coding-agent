/** The daemon's session and backlog lists and its status link; colours come from the shared tokens. */
export const DAEMON_CSS = `/* Web daemon shell */
.daemon-content { display: grid; gap: 16px; max-width: 880px; width: 100%; margin-inline: auto; }
.daemon-list { list-style: none; margin: 0; padding: 0; }
.daemon-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border-soft); }
.daemon-list > .daemon-row:last-child { border-bottom: 0; }
.daemon-row-main { display: grid; gap: 2px; min-width: 0; flex: 1 1 240px; }
.daemon-row-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.daemon-path { overflow-wrap: anywhere; font-size: 12px; }
.daemon-row.needs-you { background: color-mix(in srgb, var(--warning, #d97706) 8%, transparent); }
.daemon-needs-you { font-weight: 600; }
.daemon-actions, .daemon-status { display: inline-flex; align-items: center; gap: 8px; }
.daemon-note { justify-self: end; }
@media (forced-colors: active) { .daemon-row { border-bottom-color: CanvasText; } }
`;
