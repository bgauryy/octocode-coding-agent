import { reapOrphanGroups, recordProcessGroup } from "@octocodeai/octocode-common/process-group-records";
import { hostServerRecordsDir } from "../../host.ts";

/**
 * Owner records of stdio server groups: a server's `npx`/`uvx` tree survives an Octocode that died without closing it
 * (SIGKILL, out of memory), so each group is recorded while it runs and the first server this process starts reaps
 * the groups whose owner is gone. Without a host folder (a transport used on its own) nothing is recorded.
 */

const reaped = new Map<string, Promise<void>>();

function warn(what: string, error: unknown): void {
	process.emitWarning(`MCP stdio ${what}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Reaps the dead owners' groups once per folder and process; a failure is reported and never blocks the start. */
export function reapStdioOrphans(): Promise<void> {
	const dir = hostServerRecordsDir();
	if (!dir) return Promise.resolve();
	let pending = reaped.get(dir);
	if (!pending) {
		pending = reapOrphanGroups(dir).then(
			() => undefined,
			(error: unknown) => warn("orphan reap failed", error),
		);
		reaped.set(dir, pending);
	}
	return pending;
}

/** Records the group led by `pid`; returns a function that removes the record (a no-op without a host folder). */
export function recordStdioGroup(pid: number, label: string): () => Promise<void> {
	const dir = hostServerRecordsDir();
	if (!dir) return () => Promise.resolve();
	const written = recordProcessGroup(dir, pid, label).catch((error: unknown) => {
		warn("owner record failed", error);
		return () => {};
	});
	return async () => (await written)();
}
