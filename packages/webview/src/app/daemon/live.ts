import type { LiveExtension } from "../extension.ts";
import type { PageScope } from "../../scope.ts";
import { ConnectionStatus } from "../live/session.tsx";
import { createElement, type ReactNode } from "react";

const REPO_VIEWS = new Set(["rfc", "research", "audit"]);

function DaemonStatus(): ReactNode {
	return createElement(
		"span",
		{ className: "daemon-status" },
		createElement("a", { href: "/#sessions", className: "btn" }, "All sessions"),
		createElement(ConnectionStatus),
	);
}

/**
 * The live extension for a page the daemon serves, scoped to a session or a repository: the same components, with a
 * link back to the session list. `writable` is what the daemon said about the page's token (`GET /api/access`): false
 * hides every edit control, and a repository scope (no session) shows only the views that read saved data. When it is
 * unknown (`undefined`), a repository page is read-only and a session page keeps its controls. The flag hides controls
 * only; the daemon still refuses a write the token does not allow.
 */
export function daemonLive(live: LiveExtension, scope: NonNullable<PageScope>, writable?: boolean): LiveExtension {
	const readOnly = writable === undefined ? scope.kind === "repo" : !writable;
	return {
		...live,
		ConnectionStatus: DaemonStatus,
		...(readOnly ? { readOnly: true } : {}),
		...(scope.kind === "repo" ? { views: live.views.filter((view) => REPO_VIEWS.has(view.name)) } : {}),
	};
}
