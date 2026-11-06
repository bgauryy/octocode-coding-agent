/// <reference lib="dom" />
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { createBacklogStore } from "./app/extension.ts";
import { live } from "./app/live/index.ts";
import { DaemonShell } from "./app/daemon/DaemonShell.tsx";
import { DaemonScopedApp } from "./app/daemon/ScopedApp.tsx";
import { pageScope } from "./scope.ts";

/** Browser entry: read the embedded snapshot, take the launch token (live only), then render. */
export function mountPage(): void {
	const access = live?.takeAccess() ?? "";
	const snapshot: Snapshot = JSON.parse(document.getElementById("data")?.textContent || "{}");
	const container = document.getElementById("app");
	if (!container) throw new Error("Missing element: app");
	const root = createRoot(container);
	// The user-level daemon serves this page too: with no scope it is the session list, otherwise the live app on one scope.
	const daemon = live !== null && document.body.dataset.daemon === "true";
	const scope = pageScope();
	root.render(
		<StrictMode>
			{daemon && !scope ? (
				<DaemonShell access={access} />
			) : daemon && live && scope ? (
				<DaemonScopedApp backlog={createBacklogStore(snapshot, false)} live={live} scope={scope} access={access} />
			) : (
				<App backlog={createBacklogStore(snapshot, live === null)} live={live} access={access} />
			)}
		</StrictMode>,
	);
	window.addEventListener("pagehide", () => root.unmount(), { once: true });
}
