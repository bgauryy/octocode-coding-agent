import type { UiState } from "../../theme/status.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { RenderContext } from "./render/types.ts";

/**
 * A tool row's header is drawn by `renderCall`, which does not see the result. A tool whose mark depends on its result
 * (an agent that reports `Blocked`, a question the user declined) has its result renderer record the state here, on the
 * row's shared state, and the header reads it back. Only a state the header would not draw by itself is recorded
 * (spinner while running, `✓` when done, `✗` on error are its own).
 */
export function shareRowState(context: RenderContext, state: UiState | undefined): void {
	share(context, "mark", state);
}

/** Records on the row what its result knows and the header does not: the model and level an agent resolved to. */
export function shareRowModel(context: RenderContext, model: string | undefined): void {
	share(context, "model", model);
}

function share<K extends "mark" | "model">(context: RenderContext, key: K, value: SharedRow[K]): void {
	if (!isRecord(context.state)) return;
	const row = context.state as SharedRow;
	if (row[key] === value) return;
	row[key] = value;
	// The header already drew without it: redraw once, after this pass.
	const invalidate = context.invalidate;
	if (invalidate) queueMicrotask(() => invalidate());
}

interface SharedRow {
	mark?: UiState | undefined;
	model?: string | undefined;
}

/** The state `shareRowState` recorded for this row; undefined when the header's own mark is right. */
export function sharedRowState(context: RenderContext): UiState | undefined {
	return isRecord(context.state) ? (context.state as SharedRow).mark : undefined;
}

/** The model `shareRowModel` recorded for this row; undefined before the result reports one. */
export function sharedRowModel(context: RenderContext): string | undefined {
	return isRecord(context.state) ? (context.state as SharedRow).model : undefined;
}
