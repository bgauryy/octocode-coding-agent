import { wholeSeconds, withTimeout } from "../../shared/util.ts";
import { abortError } from "../abort.ts";
import type { BrowserSession } from "../cdp/browser-session.ts";

type Page = BrowserSession["page"];
/** How long an action waits to see whether it started a navigation. */
const NAVIGATION_PROBE_MS = 150;
/** How long a navigation the action started may take to load. */
const LOAD_MS = 10_000;
/** DOM quiet time that counts as settled, and the longest wait for it. */
const DOM_QUIET_MS = 150;
const DOM_MAX_MS = 3_000;

/**
 * After an action: wait briefly to see whether it started a navigation (a link, a form post) and, if so, for the load
 * to finish; then until the DOM has been quiet for a moment (an SPA re-rendering), capped. Never fails on a timeout:
 * the snapshot that follows shows whatever is there.
 */
export async function settle(
	page: Pick<Page, "on" | "evaluate">,
	signal?: AbortSignal,
	timing = { probeMs: NAVIGATION_PROBE_MS, loadMs: LOAD_MS, quietMs: DOM_QUIET_MS, domMaxMs: DOM_MAX_MS },
): Promise<void> {
	const loading = new Set<string>();
	let wake: (() => void) | undefined;
	const off = page.on((method, params) => {
		if (method === "Page.frameStartedLoading") loading.add(String(params.frameId));
		else if (method === "Page.frameStoppedLoading") loading.delete(String(params.frameId));
		else return;
		wake?.();
	});
	const pause = (ms: number, done: () => boolean) =>
		new Promise<void>((resolve, reject) => {
			if (signal?.aborted) return reject(abortError(signal));
			const finish = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				wake = undefined;
				resolve();
			};
			const onAbort = () => {
				clearTimeout(timer);
				wake = undefined;
				reject(abortError(signal!));
			};
			const timer = setTimeout(finish, ms);
			wake = () => done() && finish();
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	try {
		await pause(timing.probeMs, () => loading.size > 0);
		if (loading.size > 0) await pause(timing.loadMs, () => loading.size === 0);
	} finally {
		off();
	}
	// A page torn down mid-wait (another navigation) or an open dialog ends the quiet wait early; either is fine here, an abort is not.
	await page
		.evaluate(
			`new Promise((resolve) => { let timer; const done = () => { observer.disconnect(); clearTimeout(cap); resolve(true); }; const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${timing.quietMs}); }); observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); timer = setTimeout(done, ${timing.quietMs}); const cap = setTimeout(done, ${timing.domMaxMs}); })`,
			signal,
		)
		.catch((error: unknown) => {
			if (signal?.aborted) throw error;
		});
}

/** After a navigation's load event: how long content and requests must stay quiet, and the longest wait. */
const LOAD_QUIET_MS = 500;
const LOAD_MAX_MS = 6_000;

/**
 * After a navigation has loaded: waits until the page's content (nodes and text, not attribute-only animation) and its
 * network requests have both been quiet for `quietMs`, capped at `maxMs`, so values a script fills in after load
 * (prices, a localized currency, search results) are in the snapshot. Resolves how long it took and whether the page
 * went quiet. A wait that could not run (the page was torn down, the evaluate failed) is not settled and says so in
 * `failed`; only an abort throws.
 */
export async function settleAfterLoad(
	page: Pick<Page, "evaluate">,
	signal?: AbortSignal,
	quietMs = LOAD_QUIET_MS,
	maxMs = LOAD_MAX_MS,
): Promise<{ settled: boolean; failed: boolean; ms: number }> {
	const started = Date.now();
	let failed = false;
	const quiet = await page
		.evaluate<boolean>(
			`new Promise((resolve) => { let timer; let perf; const finish = (quiet) => { observer.disconnect(); if (perf) perf.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(quiet); }; const poke = () => { clearTimeout(timer); timer = setTimeout(() => finish(true), ${quietMs}); }; const observer = new MutationObserver(poke); observer.observe(document, { subtree: true, childList: true, characterData: true }); try { perf = new PerformanceObserver(poke); perf.observe({ type: 'resource' }); } catch {} poke(); const cap = setTimeout(() => finish(false), ${maxMs}); })`,
			signal,
		)
		.catch((error: unknown) => {
			if (signal?.aborted) throw error;
			failed = true;
			return false;
		});
	return { settled: quiet, failed, ms: Date.now() - started };
}

/** The page text `waitForText` searches: the document, open shadow roots and same-origin frames. */
const PAGE_TEXT = `(() => { const parts = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { parts.push([...el.shadowRoot.children].map((c) => c.innerText || '').join(' ')); walk(el.shadowRoot); } if (el.tagName === 'IFRAME') { try { if (el.contentDocument?.body) { parts.push(el.contentDocument.body.innerText); walk(el.contentDocument); } } catch {} } } }; if (document.body) { parts.push(document.body.innerText); walk(document); } return parts.join('\\n'); })()`;

/**
 * Polls until `text` appears on the page (or, with `gone`, disappears), up to `timeoutMs`; resolves with how long it
 * took, or undefined when a JavaScript dialog opened (it blocks the page, so the caller reports it). Throws on timeout,
 * naming what was expected. A probe never runs past the time left, so a stalled page cannot stretch the wait.
 */
export async function waitForText(
	page: Pick<Page, "evaluate" | "untilDialog">,
	text: string,
	gone: boolean,
	timeoutMs: number,
	signal?: AbortSignal,
	intervalMs = 250,
): Promise<number | undefined> {
	const started = Date.now();
	for (;;) {
		const left = Math.max(timeoutMs - (Date.now() - started), intervalMs);
		const probe = await page.untilDialog(
			withTimeout(page.evaluate<string>(PAGE_TEXT, signal), left, "wait").then(
				(body) => ({ body: String(body) }),
				() => ({ body: undefined }),
			),
		);
		if (!probe) return undefined;
		// A probe that failed (a navigation tore the page down) or ran out of time proves nothing either way.
		if (probe.body !== undefined && probe.body.includes(text) !== gone) return Date.now() - started;
		if (Date.now() - started >= timeoutMs)
			throw new Error(
				`Timed out after ${wholeSeconds(timeoutMs)}s waiting for ${JSON.stringify(text)} to ${gone ? "disappear" : "appear"}.`,
			);
		if (signal?.aborted) throw abortError(signal);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
