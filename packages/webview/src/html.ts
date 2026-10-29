import { STATES, type Snapshot } from "@octocodeai/octocode-contacts/snapshot";
import { OCTOCODE_FAVICON_DATA_URI } from "./favicon.generated.ts";
import { OFFLINE_PAGE_JS, WORKSPACE_STATE_JS } from "./state.generated.ts";
import { PAGE_CSS } from "./styles.ts";

/** Offline and inert: only this page's own inline style and script may run; nothing loads, submits or connects. */
const CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * JSON that is safe inside a `<script type="application/json">` block: every `<` is escaped (so no text can write `</script>`
 * or `<!--`), and so are U+2028 and U+2029, which older script engines treat as line breaks. `JSON.parse` reads it back unchanged.
 */
export function embeddedJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * The backlog as one static page: the data in a JSON block, the style and script inline. Nothing from the data is placed
 * in the markup; React renders the page from the parsed data as text, never as HTML.
 */
export function renderBacklogHtml(snapshot: Snapshot, live = false, daemon = false): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}${live ? "; connect-src 'self'" : ""}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#6d28d9">
<link rel="icon" type="image/png" href="${OCTOCODE_FAVICON_DATA_URI}">
<title>Backlog</title>
<style>${PAGE_CSS}</style>
</head>
<body data-live="${live}"${daemon ? ' data-daemon="true"' : ""}>
<div id="app"></div>
<noscript>This page needs JavaScript. The backlog data is in the page source, in the JSON block with id "data".</noscript>
<script type="application/json" id="data">${embeddedJson(snapshot)}</script>
<script>${live ? WORKSPACE_STATE_JS : OFFLINE_PAGE_JS}
WorkspaceView.mountPage();</script>
</body>
</html>
`;
}

/** The page the user-level daemon serves: live, with no data embedded; the scope (`?s=` or `?r=`) and token come from the URL. */
export function renderDaemonHtml(): string {
	return renderBacklogHtml(
		{ repo: "Octocode", generatedAt: 0, states: STATES, idleMs: 604800000, items: [] },
		true,
		true,
	);
}
