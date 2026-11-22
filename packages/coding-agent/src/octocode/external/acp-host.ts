import { AcpBackend, type AcpConnectInput, type AcpPermission } from "../../../../acp/src/client/client.ts";
import type { AcpClientHost } from "../../../../acp/src/host.ts";
import { adoptTree, KILL_GRACE_MS, prepareTree, reapWithParent, stopTree } from "../shared/process.ts";
import { saveTimestamped } from "../shared/spill.ts";
import { agentEnv } from "./runner-env.ts";
import { type DescendantPoller, pollDescendants } from "../shared/descendant-poller.ts";
import { descendantRows } from "../shared/process-descendants.ts";

/** The adapters' descendant pollers, from adoption to stop: one per process. */
const pollers = new Map<number, DescendantPoller>();

/** What the ACP workspace's outbound client takes from this application: private output files, process-tree control and a cleaned environment. */
export const acpClientHost: AcpClientHost = {
	saveOutput: saveTimestamped,
	processTree: {
		graceMs: KILL_GRACE_MS,
		prepare: prepareTree,
		adopt: (pid) => {
			adoptTree(pid);
			reapWithParent(pid);
			if (pid !== undefined && !pollers.has(pid)) pollers.set(pid, pollDescendants(pid));
		},
		stop: async (pid, graceful) => {
			const poller = pid === undefined ? undefined : pollers.get(pid);
			if (pid !== undefined) pollers.delete(pid);
			if (!poller) {
				// Not adopted: one snapshot before a graceful shutdown, none for a direct stop.
				if (!graceful) return stopTree(pid);
				const retained = await descendantRows(pid).catch(() => []);
				try {
					await graceful();
				} finally {
					await stopTree(pid, KILL_GRACE_MS, retained);
				}
				return;
			}
			// Read before the graceful shutdown: once the root exits, its helpers no longer show as its descendants.
			await poller.snapshot();
			try {
				if (graceful) await graceful();
			} finally {
				// Every descendant seen since adoption, not only those alive now: a helper reparents once its parent exits.
				await stopTree(pid, graceful ? KILL_GRACE_MS : undefined, await poller.stop());
			}
		},
	},
	childEnv: (vendor) => agentEnv(vendor),
};

/** The one place the outbound client is installed with its host. */
export function connectAcp(
	input: AcpConnectInput,
	permission: AcpPermission,
	signal?: AbortSignal,
): Promise<AcpBackend> {
	return AcpBackend.connect(acpClientHost, input, permission, signal);
}
