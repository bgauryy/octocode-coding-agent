/** Tokens, document base and the dialog reset. */
export const BASE_CSS = `
:root {
	color-scheme: light dark;
	--bg: #f6f8fa; --surface: #ffffff; --surface-2: #f6f8fa; --surface-3: #eaeef2;
	--border: #d0d7de; --border-soft: #eaeef2;
	--text: #24292f; --text-2: #4b5563; --text-3: #5b6472;
	--accent: #6d28d9; --accent-strong: #5b21b6; --accent-soft: #f3e8ff; --accent-line: #ddd6fe; --on-accent: #ffffff;
	--success: #166534; --danger: #b91c1c; --warning: #92400e; --tool: #0369a1; --agent: #6d28d9; --teal: #0d9488; --coral: #c2410c; --lav: #4f46e5;
	/* One state system: pending (backlog) is neutral, running (ongoing) is the accent, waiting is the warning, stopped is neutral and darker than pending. */
	--state-pending: var(--text-3); --state-running: var(--accent); --state-waiting: var(--warning); --state-done: var(--success); --state-failed: var(--danger); --state-stopped: var(--text-2);
	--state-backlog: var(--state-pending); --state-todo: var(--text-2); --state-ongoing: var(--state-running);
	--shadow-sm: 0 1px 2px rgb(31 35 40 / .06); --shadow-md: 0 4px 12px rgb(31 35 40 / .08); --shadow-lg: 0 24px 64px rgb(31 35 40 / .22);
	--radius-sm: 6px; --radius: 8px; --radius-lg: 12px;
	--font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
	--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
	--ease: cubic-bezier(.2, .8, .2, 1);
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0d1117; --surface: #161b22; --surface-2: #1c2128; --surface-3: #21262d;
		--border: #30363d; --border-soft: #21262d;
		--text: #e6edf3; --text-2: #a7b0bc; --text-3: #8b949e;
		--accent: #c084fc; --accent-strong: #a78bfa; --accent-soft: #1a1426; --accent-line: #3b2a5c; --on-accent: #0d1117;
		--success: #56d364; --danger: #ff6b6b; --warning: #f2c14e; --tool: #7dd3fc; --agent: #c084fc; --teal: #5eead4; --coral: #ff8a65; --lav: #a5b4fc;
		--shadow-sm: 0 1px 2px rgb(0 0 0 / .3); --shadow-md: 0 4px 12px rgb(0 0 0 / .35); --shadow-lg: 0 24px 64px rgb(0 0 0 / .6);
	}
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
code, kbd, pre { font-family: var(--mono); }
code { font-size: 12px; overflow-wrap: anywhere; }
h1, h2, h3, h4 { margin: 0; line-height: 1.25; }
ul, ol { margin: 0; padding: 0; list-style: none; }
p { margin: 0; }
/* Open dialogs are positioned and styled by their component class; drop the user-agent dialog box. */
dialog { inset: auto; width: auto; height: auto; margin: 0; padding: 0; border: 0; background: none; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
::selection { background: var(--accent-soft); }
.icon { flex-shrink: 0; }
.muted { color: var(--text-2); overflow-wrap: anywhere; }
.nowrap { white-space: nowrap; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.ref { font-family: var(--mono); font-size: 12px; color: var(--text-3); font-weight: 500; white-space: nowrap; }
a.ref { color: var(--text-2); }
.count { display: inline-grid; place-items: center; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); font-size: 11px; font-weight: 600; }
.kbd { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; background: var(--surface); color: var(--text-3); font-size: 10px; font-weight: 600; line-height: 1; }

`;
