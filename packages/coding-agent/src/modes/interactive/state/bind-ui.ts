/** Starts every binder that follows the interactive UI store; returns the function that stops them all. */

import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { bindEditorState } from "./bind-editor.ts";
import { bindRender } from "./bind-render.ts";
import { bindStatusIndicator } from "./bind-status.ts";
import { bindViewState } from "./bind-view.ts";

type BindUiHost = Parameters<typeof bindViewState>[0] &
	Parameters<typeof bindEditorState>[0] &
	Parameters<typeof bindStatusIndicator>[0];

export function bindUiState(host: BindUiHost & Pick<InteractiveModeHost, "ui">): () => void {
	const stops = [
		bindViewState(host),
		bindEditorState(host),
		bindStatusIndicator(host),
		bindRender(host.uiStore, host.ui),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
