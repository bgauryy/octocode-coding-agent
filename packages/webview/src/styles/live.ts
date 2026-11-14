/** Command palette, live activity and session views, Markdown and code. */
export const LIVE_CSS = `/* Command palette */
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
.item-implementation { display: grid; flex-basis: 100%; gap: 8px; padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--accent-soft); }
.item-implementation .command { align-items: flex-start; }
.item-implementation p { font-size: 12px; }

.activity-view, .agents-view, .audit-view { max-width: 1040px; width: 100%; margin-inline: auto; }
.activity-view { grid-template-columns: minmax(0, 1fr); }
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
.dialog-answer { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--warning, #d97706); border-radius: var(--radius-sm); }
.dialog-answer-title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.dialog-answer-options { display: flex; flex-wrap: wrap; gap: 8px; }
.dialog-answer-option { display: grid; gap: 2px; max-width: 28em; }
.dialog-answer-description { font-size: 0.85em; overflow-wrap: anywhere; }
.dialog-answer-card { display: grid; gap: 4px; }
.dialog-answer-question { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dialog-answer-meta { margin: 0; font-size: 0.85em; overflow-wrap: anywhere; }
.dialog-answer-body { margin: 0; padding-left: 10px; border-left: 2px solid var(--border, #8884); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24em; overflow: auto; }
.dialog-answer-warning { margin: 0; color: var(--warning, #d97706); }
.dialog-answer-text { display: flex; gap: 8px; }
.dialog-answer-text input { flex: 1; min-width: 0; }
.dialog-answer-status { margin: 0; }
.composer-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.composer-actions > .field { flex: 1 1 200px; }
.composer-actions > .btn { min-height: 36px; }
.queue-chips, .receipts li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
.receipts { display: grid; gap: 6px; }
.receipts li > span { min-width: 0; overflow-wrap: anywhere; }
.feed-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.feed-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.feed-status .live-dot { color: var(--success); }
.activity-feed { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.result-card { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-left: 3px solid var(--tone); border-radius: var(--radius); background: var(--surface); overflow-wrap: anywhere; content-visibility: auto; contain-intrinsic-size: auto 160px; }
.result-card.is-compact { padding: 10px 12px; gap: 6px; border-left-width: 2px; box-shadow: none; }
.result-card [role=alert]:not(:empty) { color: var(--danger); font-size: 13px; }
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
@keyframes spin { to { transform: rotate(360deg); } }
.tool-group-list { display: grid; gap: 6px; padding: 0 10px 10px; }
.agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 12px; }
.agent-grid, .agent-tree { list-style: none; margin: 0; padding: 0; }
.agent-grid > li { display: grid; gap: 10px; align-content: start; }
.agent-tree { display: grid; gap: 10px; margin-left: 14px; padding-left: 12px; border-left: 2px solid var(--border); }
.agent-card.needs-attention { border-color: color-mix(in srgb, var(--warning) 50%, var(--border)); }
.agent-last, .agent-locks { font-size: 12px; overflow-wrap: anywhere; }
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

/* Shared conversation content */
.content-blocks { display: grid; gap: 12px; min-width: 0; }
.content-asset { display: grid; gap: 8px; margin: 0; padding: 10px; border: 1px solid var(--border-soft); border-radius: var(--radius); }
.content-asset img, .content-asset video { display: block; max-width: 100%; max-height: 520px; object-fit: contain; border-radius: var(--radius-sm); }
.content-asset audio { max-width: 100%; }
.content-asset figcaption, .content-citations, .message-metadata { font-size: 12px; color: var(--text-2); }
.content-citations { padding-left: 22px; list-style: decimal; }
.message-metadata { display: flex; flex-wrap: wrap; gap: 10px; }
.reasoning-block { padding: 10px 12px; border-left: 2px solid var(--accent-line); background: var(--surface-2); border-radius: var(--radius-sm); }
.reasoning-block > summary { cursor: pointer; color: var(--text-2); font-size: 12px; }
.reasoning-block[open] > summary { margin-bottom: 8px; }
.content-tool { display: grid; gap: 8px; min-width: 0; padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius); background: var(--surface-2); }
.content-tool.is-failed { border-color: var(--danger); }
.content-tool > header { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; font-size: 12px; }
.content-tool > header strong { font-family: var(--mono); }
.content-tool > header span { color: var(--text-2); }
.tool-display { display: grid; gap: 6px; min-width: 0; }
.tool-display-outcome { margin: 0; font-size: 13px; color: var(--text-2); overflow-wrap: anywhere; }
.tool-display .tone-error { color: var(--danger); } .tool-display .tone-warning { color: var(--warning); } .tool-display .tone-success { color: var(--success); } .tool-display .tone-muted { color: var(--text-3); }
.tool-display-subjects, .tool-display-list { margin: 0; padding-left: 18px; font-size: 13px; overflow-wrap: anywhere; }
.tool-display-list { list-style: none; padding-left: 0; } .tool-display-list li { display: block; }
.tool-display-fields { display: grid; gap: 2px; margin: 0; font-size: 13px; } .tool-display-fields div { display: flex; gap: 8px; } .tool-display-fields dt { color: var(--text-2); } .tool-display-fields dd { margin: 0; overflow-wrap: anywhere; }
.tool-display-path { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.tool-display-preview .link-button, .tool-display .link-button { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; font-size: 12px; }
.tool-output { margin: 0; display: grid; gap: 4px; } .tool-output figcaption { font-size: 12px; overflow-wrap: anywhere; }
.tool-progress { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.tool-progress progress { flex: 0 0 120px; accent-color: var(--accent); }
.content-tool > .tool-reason { margin: 0; color: var(--text-3); font-size: 12px; font-style: italic; overflow-wrap: anywhere; }
.content-tool > .tool-purposes { display: grid; gap: 2px; color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
.tool-purposes > p { margin: 0; }
.tool-purposes > .purpose-reasoning { font-style: italic; }
.resource-reference, .unsupported-block { font-size: 13px; }
.composer-attachments { display: grid; gap: 8px; }
.attachment-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 12px; color: var(--text-2); }
.attachment-picker input { max-width: 100%; font-size: 12px; }
.composer-attachments ul { display: flex; flex-wrap: wrap; gap: 6px; }
.composer-attachments li { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; }

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

`;
