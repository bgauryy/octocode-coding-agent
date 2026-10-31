import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { timedTool } from "../shared/render/rows.ts";
import { visibleError } from "../shared/visible-error.ts";
import { dialogNotice } from "./actions.ts";
import { browserCallHeader, browserResult } from "./render.ts";
import type { BrowserTool } from "./tool/browser-tool.ts";
import { isSessionAction, PAGE_HANDLERS, pageResult, SESSION_HANDLERS } from "./tool/handlers.ts";
import { PARAMETERS } from "./tool/parameters.ts";

/** Actions that talk to the page, so an open JavaScript dialog must be answered first. */
const PAGE_ACTIONS = new Set([
	"click",
	"hover",
	"drag",
	"type",
	"fill",
	"press",
	"wait",
	"evaluate",
	"upload",
	"download",
]);

export function registerBrowserTool(api: ExtensionAPI, browser: BrowserTool): void {
	api.registerTool(
		timedTool(
			{
				name: "browser",
				label: "Browser",
				// Browsing defaults to the built-in browser MCP server (`mcp__browser__*`); this tool is enabled with `--tools +browser`
				// or `defaultTools`, and the browser specialist selects it for visible persistent-profile sessions.
				defaultActive: false,
				description:
					"Drive one Chrome session (JavaScript pages, forms, logins); headless unless visible mode is on. One action per call:\n" +
					"navigate(url), tab(url | index): snapshot = page text + numbered elements\n" +
					"snapshot(text?): wait for text first\n" +
					"click, hover(ref)\n" +
					"drag(ref, to | text)\n" +
					"type(ref, text, submit?), fill(fields), press(key)\n" +
					"wait(text, gone?), evaluate(expression)\n" +
					"screenshot(format?): jpeg (default) or png, shrunk to fit; result names the full-size file\n" +
					"dialog(accept?, text?), upload(ref, files), download(ref?)\n" +
					"tabs, console, info, close, attach(port: an open browser)\n" +
					"An element keeps its number while it stays on the page; a new document renumbers. Actions report what changed, so a fresh snapshot is rarely needed. A wait that times out fails with the current snapshot. Private/local addresses the agent opens (navigate, tab) and uploads outside the workspace need approval in manual and workspace permission modes. " +
					"Requests the page itself starts (images, frames, scripts, fetch, redirects) to a private or local address are blocked without asking, except the address you opened; an attached or persistent-profile Chrome only reports a page WebSocket to a private address.",
				promptSnippet: "Inspect rendered pages and act on current element refs",
				promptGuidelines: [
					"Inspect the outcome before repeating a browser click or submission, and use existing user authorization for actions with side effects.",
				],
				// One shared page: parallel actions would race (a click against a navigation, stale element refs), so browser calls
				// run one at a time (`exclusive` below) while other tools in the same message still run beside them.
				parameters: PARAMETERS,
				renderCall: (args, theme, context) => browserCallHeader(args, theme, context),
				renderResult: (result, _options, theme, context) => browserResult(result, theme, context),
				async execute(id, params, signal, _onUpdate, ctx) {
					const { action } = params;
					const callCtx = { ...ctx, signal: signal ?? ctx.signal };
					browser.useContext(callCtx, id);
					try {
						if (isSessionAction(action)) return await SESSION_HANDLERS[action](browser, params, signal);
						const session = await browser.session(signal);
						if (session.dialog && PAGE_ACTIONS.has(action)) return pageResult(dialogNotice(session.dialog));
						return await PAGE_HANDLERS[action]({
							session,
							page: session.page,
							params,
							signal,
							ctx: callCtx,
							browser,
							toolCallId: id,
						});
					} catch (error) {
						throw visibleError(error);
					}
				},
			},
			{ exclusive: true },
		),
	);
	api.on("session_shutdown", async () => browser.close({ keepVisible: true }));
}
