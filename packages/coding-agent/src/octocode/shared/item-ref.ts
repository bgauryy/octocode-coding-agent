/** A backlog item the web page can open: `B12`. The page's route takes the same shape (`#B12`). */
export const ITEM_REF = /^B\d{1,9}$/;

/**
 * The target of a drawn backlog id. It names no server and carries no credential: a link in scrollback must not hold
 * one, and a launch code opens the page once and expires. Fullscreen mode resolves a click on it through
 * `openItemLink`; a terminal that opens links itself finds nothing at this address, so the plain `/web item <id>`
 * stays the way in there.
 */
const MARKER = "http://127.0.0.1/__octocode/item/";

export function itemLinkUrl(ref: string): string {
	return MARKER + ref;
}

/** The item a link target names, or undefined for any other URL. */
export function parseItemLink(url: string): string | undefined {
	if (!url.startsWith(MARKER)) return undefined;
	const ref = url.slice(MARKER.length);
	return ITEM_REF.test(ref) ? ref : undefined;
}

let handler: ((ref: string) => void) | undefined;

/** Registers what a click on an item link does (`/web item`); undefined removes it. */
export function setItemLinkHandler(next: ((ref: string) => void) | undefined): void {
	handler = next;
}

let clicksIntercepted = false;

/**
 * Tells whether this terminal mode hands a click on a link to `openItemLink`. Only fullscreen mode does: in regular mode
 * the terminal opens a link itself and the item target names no server, so a drawn link would be dead.
 */
export function setItemClicksIntercepted(on: boolean): void {
	clicksIntercepted = on;
}

/** Whether a drawn item id can be clicked: the mode intercepts clicks and a `/web item` handler is registered. */
export function itemLinksClickable(): boolean {
	return clicksIntercepted && handler !== undefined;
}

/**
 * Routes a clicked URL: an item link goes to the registered handler, anything else to `fallback`. An item link with no
 * handler (no web command in this session) opens nothing.
 */
export function openItemLink(url: string, fallback: (url: string) => void): void {
	const ref = parseItemLink(url);
	if (ref === undefined) return fallback(url);
	handler?.(ref);
}
