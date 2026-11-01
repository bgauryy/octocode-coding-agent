import { AcpBackend, type AcpConnectInput, type AcpPermission } from "../../../../acp/src/client/client.ts";
import type { AcpClientHost } from "../../../../acp/src/host.ts";
import { adoptTree, KILL_GRACE_MS, prepareTree, stopTree } from "../shared/process.ts";
import { saveTimestamped } from "../shared/spill.ts";

/** What the ACP workspace's outbound client takes from this application: private output files and process-tree control. */
export const acpClientHost: AcpClientHost = {
	saveOutput: saveTimestamped,
	processTree: { graceMs: KILL_GRACE_MS, prepare: prepareTree, adopt: adoptTree, stop: (pid) => stopTree(pid) },
};

/** The one place the outbound client is installed with its host. */
export function connectAcp(
	input: AcpConnectInput,
	permission: AcpPermission,
	signal?: AbortSignal,
): Promise<AcpBackend> {
	return AcpBackend.connect(acpClientHost, input, permission, signal);
}
