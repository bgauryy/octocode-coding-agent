/** Where both page servers serve the service worker; its scope is the whole origin. */
export const SERVICE_WORKER_ROUTE = "/octocode-sw.js";

/** Where both page servers keep the web workspace preferences (the notification sound). */
export const WEB_PREFS_ROUTE = "/api/web-prefs";

/** What a page server needs to answer the worker and preference routes, in one value so hosts pass it on whole. */
export interface WebPageAssets {
	workerRoute: string;
	workerSource: string;
	prefsRoute: string;
}

/** The message the worker sends a focused window when a notification is clicked. */
export const NOTIFICATION_OPEN_MESSAGE = "octocode:open";

/**
 * The service worker's source. The page shows notifications itself (`registration.showNotification`); the worker
 * exists so the OS can deliver the click: it focuses the existing window and tells it which session view to open,
 * or opens one when none is left. It holds no state and reads nothing from the network.
 */
export const SERVICE_WORKER_JS = `"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const search = typeof data.search === "string" ? data.search : "";
	const hash = typeof data.hash === "string" ? data.hash : "";
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		const own = windows.find((client) => new URL(client.url).origin === self.location.origin);
		if (own) {
			await own.focus();
			own.postMessage({ type: ${JSON.stringify(NOTIFICATION_OPEN_MESSAGE)}, search, hash });
			return;
		}
		await self.clients.openWindow(self.registration.scope + search + hash);
	})());
});
`;

export const WEB_PAGE_ASSETS: WebPageAssets = {
	workerRoute: SERVICE_WORKER_ROUTE,
	workerSource: SERVICE_WORKER_JS,
	prefsRoute: WEB_PREFS_ROUTE,
};
