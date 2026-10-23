import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../../../extensions/tool-search/tool.ts";

/**
 * Keeps core `read` active while Octocode's local readers are unavailable, so an existing file can still be read before
 * the file tool changes it. It removes `read` again only if it was the one that added it: a `read` the user turned on
 * stays. While the server is still connecting nothing changes, so the declared tools (and the cached prefix) hold.
 */
export function fallbackReader(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools">) {
	let added = false;
	return (unavailable: boolean): void => {
		try {
			const active = pi.getActiveTools();
			if (unavailable && !active.includes("read") && pi.getAllTools().some((tool) => tool.name === "read")) {
				pi.setActiveTools([...active, "read"]);
				added = true;
			} else if (!unavailable && added) {
				pi.setActiveTools(active.filter((tool) => tool !== "read"));
				added = false;
			}
		} catch {
			// The session is shutting down or not bound yet; the next status change retries.
		}
	};
}

/** Activate native discovery for deferred tools when the discovery tool is registered. */
export function activateDiscovery(pi: ExtensionAPI): void {
	try {
		const active = pi.getActiveTools();
		if (
			active.includes(TOOL_SEARCH_TOOL_NAME) ||
			!pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools)
		)
			return;
		pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
	} catch {
		// The session is shutting down or not bound yet; the next registration retries.
	}
}
