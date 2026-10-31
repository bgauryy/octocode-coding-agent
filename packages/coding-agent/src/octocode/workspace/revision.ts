import type { WorkspaceConnection } from "@octocodeai/octocode-contracts/workspace";

/** A workspace connection that can say cheaply whether its snapshot may have changed. */
export interface RevisedWorkspace extends WorkspaceConnection {
	/**
	 * A stamp that differs whenever `snapshot()` may differ; equal stamps mean an unchanged snapshot. Undefined when some
	 * input cannot be stamped: the caller then compares serialized snapshots.
	 */
	revision?(): string | undefined;
}

/**
 * Tells whether the workspace snapshot changed since the last call. With a stamp, an unchanged stamp skips building,
 * redacting and serializing the snapshot; a changed stamp still compares the serialized snapshot, so a stamp that moves
 * without a visible change sends nothing. Throws what `revision` or `snapshot` throws (a closed session).
 */
export function workspaceChanges(workspace: RevisedWorkspace): () => boolean {
	let stamp: string | undefined;
	let serialized = "";
	return () => {
		const revision = workspace.revision?.();
		if (revision !== undefined && revision === stamp) return false;
		const next = JSON.stringify(workspace.snapshot());
		stamp = revision;
		if (next === serialized) return false;
		serialized = next;
		return true;
	};
}
