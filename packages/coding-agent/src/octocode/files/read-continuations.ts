import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { isWorkspaceReader, resultData, snapshotLocalReads } from "../shared/local-reads.ts";

type Snapshots = Awaited<ReturnType<typeof snapshotLocalReads>>;
type Calls = Map<string, Snapshots>;
interface Continuation {
	snapshots: Snapshots;
	expires: number;
}
const continuations = new WeakMap<Calls, Map<string, Continuation>>();
const MAX_CONTINUATIONS = 128;
const CONTINUATION_MS = 5 * 60_000;
const key = (tool: string, cwd: string, cursor: string) => JSON.stringify([tool, cwd, cursor]);

/** Carry the original file identities through a reader's opaque continuation; never resnapshot unread changed files. */
export async function snapshotReadCall(calls: Calls, tool: string, input: Record<string, unknown>, cwd: string) {
	const snapshots = await snapshotLocalReads(tool, input, cwd);
	if (snapshots.size || !isWorkspaceReader(tool) || typeof input.cursor !== "string") return snapshots;
	const saved = continuations.get(calls)?.get(key(tool, cwd, input.cursor));
	return saved && saved.expires > Date.now() ? new Map(saved.snapshots) : snapshots;
}

/** Only continuation actions returned by a successful reader inherit its verified pre-call file identities. */
export function rememberReadContinuations(
	calls: Calls,
	tool: string,
	cwd: string,
	snapshots: Snapshots,
	output: unknown,
): void {
	const now = Date.now();
	const cache = continuations.get(calls) ?? new Map<string, Continuation>();
	continuations.set(calls, cache);
	for (const [id, saved] of cache) if (saved.expires <= now) cache.delete(id);
	const visit = (value: unknown, depth: number): void => {
		if (depth > 64) return;
		if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
		else if (isRecord(value)) {
			if (value.kind === "continue" && isRecord(value.input) && typeof value.input.cursor === "string") {
				cache.set(key(tool, cwd, value.input.cursor), {
					snapshots: new Map(snapshots),
					expires: now + CONTINUATION_MS,
				});
				while (cache.size > MAX_CONTINUATIONS) cache.delete(cache.keys().next().value!);
			}
			for (const item of Object.values(value)) if (typeof item === "object" && item !== null) visit(item, depth + 1);
		}
	};
	visit(resultData(output), 0);
}

export function clearReadContinuations(calls: Calls): void {
	continuations.delete(calls);
}
