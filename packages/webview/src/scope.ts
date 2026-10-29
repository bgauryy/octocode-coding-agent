const SCOPE_ID = /^[\w.-]{1,128}$/;

export type PageScope = { kind: "session" | "repo"; id: string } | undefined;

/** What this page is bound to: `?s=<sessionId>` or `?r=<repoId>` (the user-level daemon), else the host's own session. */
export function pageScope(search = location.search): PageScope {
	const params = new URLSearchParams(search);
	const session = params.get("s");
	if (session && SCOPE_ID.test(session)) return { kind: "session", id: session };
	const repo = params.get("r");
	if (repo && SCOPE_ID.test(repo)) return { kind: "repo", id: repo };
	return undefined;
}

/** A host route made specific to this page's scope: `/s/<id>/api/application`, `/r/<id>/api/reports`, or unchanged. */
export function scopedRoute(route: string, search = location.search): string {
	const scope = pageScope(search);
	return scope ? `/${scope.kind === "session" ? "s" : "r"}/${scope.id}${route}` : route;
}
