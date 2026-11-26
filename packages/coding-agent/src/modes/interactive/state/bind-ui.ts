/**
 * Starts every binder that follows the interactive UI store; returns the function that stops them all. Each binder asks
 * for a frame only when a row it draws changed; the editor slot's owner (`dialog-slot.ts`) asks for its own.
 */

import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { bindEditorState } from "./bind-editor.ts";
import { bindStatusIndicator } from "./bind-status.ts";
import { bindViewState } from "./bind-view.ts";

type BindUiHost = Parameters<typeof bindViewState>[0] &
	Parameters<typeof bindEditorState>[0] &
	Parameters<typeof bindStatusIndicator>[0];

export function bindUiState(host: BindUiHost & Pick<InteractiveModeHost, "ui">): () => void {
	const stops = [bindViewState(host), bindEditorState(host), bindStatusIndicator(host)];
	return () => {
		for (const stop of stops) stop();
	};
}
