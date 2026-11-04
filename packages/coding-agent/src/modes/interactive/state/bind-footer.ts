/**
 * Binds the footer data (git branch, extension statuses, provider count) to the renderer. The
 * `FooterDataProvider` is itself a `StateSource` whose snapshot is replaced on each real change, so a selection of it
 * asks for one frame per change and none for a write that changed nothing; its writers never request frames.
 */

import { watchSelection } from "@octocodeai/octocode-tui";
import type { FooterData } from "../../../core/footer-data-provider.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";

type BindFooterHost = Pick<InteractiveModeHost, "footerDataProvider" | "ui">;

/** Starts following the footer data; returns the function that stops it. */
export function bindFooterState(host: BindFooterHost): () => void {
	return watchSelection(
		host.footerDataProvider,
		(data: FooterData) => data,
		() => host.ui.requestRender(),
	);
}
