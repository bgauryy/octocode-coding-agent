import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { RenderContext } from "../render/types.ts";

/**
 * An isolated run's worktree folder is named by its agent id, which only the result knows: the result's renderer records
 * it on the row's shared state (as `shareRowModel` does for the model) and the header, drawn without the result, reads it.
 */
export function shareWorktree(context: RenderContext, id: string): void {
	if (!isRecord(context.state)) return;
	const row = context.state as { worktree?: string };
	if (row.worktree === id) return;
	row.worktree = id;
	const invalidate = context.invalidate;
	if (invalidate) queueMicrotask(() => invalidate());
}

/** The folder name `shareWorktree` recorded for this row; undefined before the result reports its agent. */
export function sharedWorktree(context: RenderContext): string | undefined {
	const worktree = isRecord(context.state) ? context.state.worktree : undefined;
	return typeof worktree === "string" ? worktree : undefined;
}
