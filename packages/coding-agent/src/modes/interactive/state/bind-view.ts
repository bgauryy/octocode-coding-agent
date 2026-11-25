/**
 * Binds the view slice to the component tree: expansion, thinking visibility and padding reach the live rows, and each
 * notice becomes a status line in the messages list (the footer shows state only). Writers only dispatch actions; each
 * binder asks for a frame only when it changed a drawn row, so a toggle nothing shows paints nothing.
 */

import { type Component, watchSelection } from "@octocodeai/octocode-tui";
import { isExpandable } from "../interactive-mode/helpers.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { forEachAssistantMessage } from "./assistant-messages.ts";
import { selectHideThinking, selectNotice, selectOutputPad, selectToolsExpanded } from "./view-slice.ts";

type BindViewHost = Pick<
	InteractiveModeHost,
	| "builtInHeader"
	| "chatContainer"
	| "customHeader"
	| "loadedResourcesContainer"
	| "pendingMessagesContainer"
	| "showStatus"
	| "uiStore"
	| "ui"
>;

/** Starts following the view slice; returns the function that stops it. */
export function bindViewState(host: BindViewHost): () => void {
	const { uiStore: store } = host;
	const stops = [
		watchSelection(store, selectToolsExpanded, (expanded) => {
			// In regular mode rows above the viewport are the terminal's scrollback: changing one replays the whole
			// transcript, so the toggle reaches only what starts in view or below.
			const reaches = (component: Component) => host.ui.isAboveViewport?.(component) !== true;
			const header = host.customHeader ?? host.builtInHeader;
			const targets = [header, ...host.loadedResourcesContainer.children, ...host.chatContainer.children];
			let changed = false;
			for (const target of targets) {
				if (!target || !isExpandable(target) || !reaches(target)) continue;
				target.setExpanded(expanded);
				changed = true;
			}
			if (changed) host.ui.requestRender();
		}),
		watchSelection(store, selectHideThinking, (hide) => {
			let changed = false;
			forEachAssistantMessage(host.chatContainer, (message) => {
				if (message.setHideThinkingBlock(hide)) changed = true;
			});
			if (changed) host.ui.requestRender();
		}),
		watchSelection(store, selectOutputPad, (pad) => {
			let changed = false;
			for (const container of [host.chatContainer, host.pendingMessagesContainer])
				for (const child of container.children)
					if ("setOutputPad" in child && typeof child.setOutputPad === "function") {
						child.setOutputPad(pad);
						changed = true;
					}
			if (changed) host.ui.requestRender();
		}),
		watchSelection(store, selectNotice, (notice) => {
			if (notice) host.showStatus(notice.text);
		}),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
