/** What the prompt's `mcps` section lists of each server, for one request. */

import { deferralOf } from "./deferral.ts";
import { loadedOnDemand } from "./on-demand.ts";
import type { McpServerListing } from "./section.ts";
import { isEnabled } from "./server.ts";
import type { McpExtensionState } from "./state.ts";

/**
 * The servers the prompt describes: enabled servers this session's selection reaches. Each block's content is what
 * `McpPresentation.describe` fixed when the prompt first described the server's catalog, so a reconnect, a failure or
 * a dropped connection changes only the state, which `mcp_status` carries.
 */
export function serverListings(state: McpExtensionState): McpServerListing[] {
	const activeTools = state.api.getActiveTools();
	const active = new Set(activeTools);
	// Name order, so an `auto:<bytes>` budget fills the same way whichever server connected first.
	const listed = state.servers
		.filter((server) => isEnabled(server) && !server.unselected)
		.sort((a, b) => (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0));
	// A server that leaves the list gets a fresh description if it comes back.
	state.presentation.retainDescribed(new Set(listed.map((server) => server.entry.name)));
	return listed.flatMap((server) => {
		const declared = [...(state.serverTools.get(server.entry.name) ?? [])]
			.filter((name) => active.has(name) && state.definitions.get(name)?.exposure === "direct")
			.map((name) => state.toolOwners.get(name)?.split("\0")[1] ?? name);
		state.recordToolsDeclared(server.entry.name, declared);
		// Registered tools left undeclared until the session needs them: the block lists them by name and trigger.
		const onDemand = new Set(
			[...(state.serverTools.get(server.entry.name) ?? [])]
				.filter((name) => !active.has(name) && state.definitions.get(name)?.onDemand === true)
				.map((name) => state.toolOwners.get(name)?.split("\0")[1] ?? name),
		);
		const deferral = deferralOf(
			server.entry,
			declared,
			state.exposureSetting(),
			activeTools,
			state.deferRoles(),
			state.recentTools(),
			loadedOnDemand(state, server.entry.name),
		);
		const connectionState = server.connection?.isStopped ? "stopped" : (server.connection?.state ?? "connecting");
		const described = state.presentation.describe(
			server.entry.name,
			declared,
			server.connection?.instructions,
			connectionState === "connected",
			onDemand.size > 0 ? { ...deferral, onDemand } : deferral,
		);
		const undeclared = [...described.tools].filter((tool) => !declared.includes(tool));
		const deferred = described.deferred.size;
		return [
			{
				entry: server.entry,
				state: connectionState,
				declared: described.tools.size > 0 || described.onDemand.size > 0,
				...(described.contract ? { contract: described.contract } : {}),
				pending: described.pending,
				...(undeclared.length > 0 ? { undeclared } : {}),
				...(deferred > 0 ? { defers: true, deferred: deferred === described.tools.size } : {}),
				...(described.onDemand.size > 0 ? { onDemand: true } : {}),
			},
		];
	});
}
