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
 * link back to the session list, and for a repository (no session) only the views that read saved data.
 */
export function daemonLive(live: LiveExtension, scope: NonNullable<PageScope>): LiveExtension {
	return {
		...live,
		ConnectionStatus: DaemonStatus,
		...(scope.kind === "repo" ? { views: live.views.filter((view) => REPO_VIEWS.has(view.name)) } : {}),
	};
}
