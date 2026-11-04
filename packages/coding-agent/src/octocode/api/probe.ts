import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ApiClient } from "./client.ts";
import { apiDir, type InstanceRecord, removeRecord, removeSocket } from "./registry.ts";

/** How long a listing waits for one instance to say whether it is busy; it reports the rest as not answering. */
const STATUS_MS = 2_000;

type InstanceState = "idle" | "busy" | "not answering";

/**
 * Asks each instance whether it is busy. A socket that refuses the connection has nothing behind it, whatever now holds
 * its pid (the kill left the record, and the pid was reused), so that record goes and the instance is left out.
 */
export async function probeInstances(
	instances: readonly InstanceRecord[],
): Promise<Array<{ instance: InstanceRecord; state: InstanceState }>> {
	const probed = await Promise.all(
		instances.map(async (instance) => {
			const state = await new ApiClient(instance)
				.call<{ state?: string; pending?: boolean }>("status", {}, { timeoutMs: STATUS_MS })
				.then(
					(status): InstanceState => (status.state === "idle" && !status.pending ? "idle" : "busy"),
					(error: unknown): InstanceState | undefined =>
						/ECONNREFUSED|ENOENT/.test(errorMessage(error)) ? undefined : "not answering",
				);
			if (state !== undefined) return { instance, state };
			removeRecord(apiDir(), instance.id);
			if (instance.socket) removeSocket(instance.socket);
			return undefined;
		}),
	);
	return probed.filter((entry) => entry !== undefined);
}
