import { devtoolsFetch } from "./launch.ts";
import type { PageTarget } from "./cdp/protocol.ts";

/**
 * Minimal Chrome DevTools Protocol client: one browser-level WebSocket (`CdpConnection`) with a session per page
 * (`CdpPage`), the `BrowserSession` state those pages share (console, origins, downloads) and the browser's targets. Opening a
 * session is `session.ts`; checking its requests is `page-network.ts`.
 */

/** The browser's page targets (tabs), in the order Chrome lists them (most recently used first). */
export async function pageTargets(port: number): Promise<PageTarget[]> {
	const targets = (await (await devtoolsFetch(port, "/json/list", 2_000)).json()) as Array<
		Partial<PageTarget> & { type: string }
	>;
	return targets.filter(
		(target): target is PageTarget & { type: string } =>
			target.type === "page" && typeof target.id === "string" && typeof target.webSocketDebuggerUrl === "string",
	);
}

/** Opens a tab on `url` in the session's browser. */
export async function openTab(port: number, url: string): Promise<PageTarget> {
	const response = await devtoolsFetch(port, `/json/new?${encodeURI(url)}`, 5_000, { method: "PUT" });
	if (!response.ok) throw new Error(`Chrome on port ${port} refused a new tab (HTTP ${response.status})`);
	return (await response.json()) as PageTarget;
}
