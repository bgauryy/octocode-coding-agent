import { decodeKittyPrintable } from "@octocodeai/octocode-tui";
import type { InteractiveModeHost } from "./host.ts";
import { openProviderManager } from "./provider-manager.ts";

/** The one line above `/providers` when it opens by itself. */
const NO_MODEL_INTRO = "no usable model yet — add a provider to start";

/** What the start with no model needs: whatever `/providers` needs, and the editor a typed command goes to. */
export type NoModelStartHost = Parameters<typeof openProviderManager>[0] & Pick<InteractiveModeHost, "editor">;

/** A `/` key, plain or as the keyboard protocol sends it. */
const isSlash = (data: string): boolean => (decodeKittyPrintable(data) ?? data) === "/";

/**
 * An interactive start with no usable model opens `/providers` on `+ Provider` under one line saying why, instead of
 * printing a warning; print and RPC modes keep the warning. The caller decides that no model is set; a failure to open
 * the page is shown, as when `/providers` is typed, and the session stays usable. A `/` typed on that page closes it and
 * starts a command in the editor, so `/status` typed at start is not lost to the page. Resolves when the page closes.
 */
export function openProvidersWithoutModel(host: NoModelStartHost): Promise<void> {
	return openProviderManager(host, "", {
		intro: NO_MODEL_INTRO,
		introClosesOn: {
			test: isSlash,
			onClosed: (data) => host.editor.handleInput(data),
			note: "Type / to close this page and run a command.",
		},
	});
}
