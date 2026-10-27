import type { UiState } from "../../theme/status.ts";
import { isRecord } from "../../utils/guards.ts";
import type { RenderContext } from "./render/types.ts";

/**
 * A tool row's header is drawn by `renderCall`, which does not see the result. A tool whose mark depends on its result
 * (an agent that reports `Blocked`, a question the user declined) has its result renderer record the state here, on the
 * row's shared state, and the header reads it back. Only a state the header would not draw by itself is recorded
 * (spinner while running, `✓` when done, `✗` on error are its own).
 */
export function shareRowState(context: RenderContext, state: UiState | undefined): void {
	if (!isRecord(context.state)) return;
	const row = context.state as { mark?: UiState | undefined };
	if (row.mark === state) return;
	row.mark = state;
	// The header already drew without it: redraw once, after this pass.
	const invalidate = context.invalidate;
	if (invalidate) queueMicrotask(() => invalidate());
}

/** The state `shareRowState` recorded for this row; undefined when the header's own mark is right. */
export function sharedRowState(context: RenderContext): UiState | undefined {
	return isRecord(context.state) ? (context.state as { mark?: UiState }).mark : undefined;
}
