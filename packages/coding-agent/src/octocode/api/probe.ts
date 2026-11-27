import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ApiClient } from "./client.ts";
import {
	apiDir,
	type InstanceRecord,
	inOwnFile,
	listInstanceEntries,
	readInstance,
	removeEntry,
	removeRecord,
	removeSocket,
} from "./registry.ts";

/** How long a listing waits for one instance to say whether it is busy; it reports the rest as not answering. */
const STATUS_MS = 2_000;

type InstanceState = "idle" | "busy" | "not answering";

/** Whether two records are the same content, as read from their files. */
const sameContent = (a: InstanceRecord | undefined, b: InstanceRecord): boolean =>
	a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * Drops a record whose socket refused. When its instance's own file (`<id>.json`) holds exactly it, that file goes with
 * its socket. Any process of the user can write a record, so a copy in another file that repeats the id costs only that
 * file: a duplicate with a dead socket never removes the instance's own record, nor a socket it merely names.
 */
function dropRefused(dir: string, instance: InstanceRecord): void {
	if (sameContent(readInstance(dir, instance.id), instance)) {
		removeRecord(dir, instance.id);
		if (instance.socket) removeSocket(instance.socket);
		return;
	}
	for (const entry of listInstanceEntries(dir, false))
		if (!inOwnFile(entry) && sameContent(entry.record, instance)) removeEntry(dir, entry);
}

/**
 * Asks each instance whether it is busy. A socket that refuses the connection has nothing behind it, whatever now holds
 * its pid (the kill left the record, and the pid was reused), so that record goes (`dropRefused`) and the instance is
 * left out.
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
			dropRefused(apiDir(), instance);
			return undefined;
		}),
	);
	return probed.filter((entry) => entry !== undefined);
}
