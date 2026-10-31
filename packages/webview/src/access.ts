/**
 * The launch capability in the browser: read it from the URL, keep it in session storage and attach it to requests.
 * The browser only carries the token it was given; the host decides what it authorizes.
 */
const ACCESS_KEY = "backlog-access";

/** `/backlog` launches with `#access=…&view=…`; the token moves to session storage and the hash becomes a plain view. */
export function readLaunch(hash: string): { access: string; hash: string } | null {
	if (!hash.startsWith("#access=")) return null;
	const launch = new URLSearchParams(hash.slice(1));
	const view = launch.get("view");
	return {
		access: launch.get("access") ?? "",
		hash: view === "activity" || view === "backlog" ? `#${view}` : "#board",
	};
}

/** Moves a launch token from the URL into session storage and returns the current one. */
export function takeAccess(): string {
	const launch = readLaunch(location.hash);
	try {
		if (launch) {
			sessionStorage.setItem(ACCESS_KEY, launch.access);
			history.replaceState(null, "", launch.hash);
			return launch.access;
		}
		return sessionStorage.getItem(ACCESS_KEY) ?? "";
	} catch {
		if (launch) location.hash = launch.hash;
		return launch?.access ?? "";
	}
}

/** The only place the token becomes a request header. */
export function bearer(access: string): { Authorization: string } {
	return { Authorization: `Bearer ${access}` };
}
