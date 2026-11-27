import { NOTIFICATION_OPEN_MESSAGE, SERVICE_WORKER_ROUTE } from "../../service-worker.ts";
import type { Notice } from "../model/notifications.ts";

export type PermissionState = "unsupported" | "default" | "granted" | "denied";

/** Notifications need the Notification API and a service worker; both exist only in a secure context. */
export function permissionState(): PermissionState {
	if (typeof Notification === "undefined" || typeof navigator === "undefined" || !("serviceWorker" in navigator))
		return "unsupported";
	return Notification.permission;
}

/** Browsers allow the prompt only from a user gesture: call this from a click handler, never on load. */
export async function requestPermission(): Promise<PermissionState> {
	if (permissionState() === "unsupported") return "unsupported";
	await Notification.requestPermission();
	return permissionState();
}

export function registerWorker(): Promise<ServiceWorkerRegistration> {
	return navigator.serviceWorker.register(SERVICE_WORKER_ROUTE, { scope: "/" });
}

/** Shows one OS notification; its `tag` is the event key, so the OS replaces rather than repeats it. */
export function showNotice(registration: ServiceWorkerRegistration, notice: Notice): Promise<void> {
	return registration.showNotification(notice.title, {
		body: notice.body,
		tag: notice.key,
		data: { search: location.search, hash: notice.hash },
	});
}

/** A click on a notification: the worker focused this window; open the session view it named. */
export function onNotificationOpen(): () => void {
	const listener = (event: MessageEvent) => {
		const data: unknown = event.data;
		if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== NOTIFICATION_OPEN_MESSAGE)
			return;
		const { search, hash } = data as { search?: unknown; hash?: unknown };
		const nextSearch = typeof search === "string" && /^(\?[\w=&.-]*)?$/.test(search) ? search : location.search;
		const nextHash = typeof hash === "string" && /^#[\w=&?./-]*$/.test(hash) ? hash : "";
		if (nextSearch === location.search) location.hash = nextHash;
		else location.assign(`${location.pathname}${nextSearch}${nextHash}`);
	};
	const container = navigator.serviceWorker;
	container.addEventListener("message", listener);
	return () => container.removeEventListener("message", listener);
}
