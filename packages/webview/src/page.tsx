/// <reference lib="dom" />
import type { Snapshot } from "@octocodeai/octocode-contacts/snapshot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { createBacklogStore } from "./app/extension.ts";
import { live } from "./app/live/index.ts";

/** Browser entry: read the embedded snapshot, take the launch token (live only), then render. */
export function mountPage(): void {
	const access = live?.takeAccess() ?? "";
	const snapshot: Snapshot = JSON.parse(document.getElementById("data")?.textContent || "{}");
	const container = document.getElementById("app");
	if (!container) throw new Error("Missing element: app");
	const root = createRoot(container);
	root.render(
		<StrictMode>
			<App backlog={createBacklogStore(snapshot, live === null)} live={live} access={access} />
		</StrictMode>,
	);
	window.addEventListener("pagehide", () => root.unmount(), { once: true });
}
