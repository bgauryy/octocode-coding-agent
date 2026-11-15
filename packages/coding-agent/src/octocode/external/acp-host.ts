import { AcpBackend, type AcpConnectInput, type AcpPermission } from "../../../../acp/src/client/client.ts";
import type { AcpClientHost } from "../../../../acp/src/host.ts";
import { adoptTree, KILL_GRACE_MS, prepareTree, stopTree } from "../shared/process.ts";
import { saveTimestamped } from "../shared/spill.ts";
import { agentEnv } from "./runner-env.ts";
import { descendantRows } from "../shared/process-descendants.ts";

/** What the ACP workspace's outbound client takes from this application: private output files, process-tree control and a cleaned environment. */
export const acpClientHost: AcpClientHost = {
	saveOutput: saveTimestamped,
	processTree: {
		graceMs: KILL_GRACE_MS,
		prepare: prepareTree,
		adopt: adoptTree,
		stop: async (pid, graceful) => {
			if (!graceful) return stopTree(pid);
			const retained = await descendantRows(pid).catch(() => []);
			try {
				await graceful();
			} finally {
				await stopTree(pid, KILL_GRACE_MS, retained);
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
