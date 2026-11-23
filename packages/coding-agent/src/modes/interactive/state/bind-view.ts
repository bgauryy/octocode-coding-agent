/**
 * Binds the view slice to the component tree: expansion, thinking visibility and padding reach the live rows, and each
 * notice becomes a status line in the messages list (the footer shows state only). Writers only dispatch actions;
 * `bindRender` requests the frame.
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
			if (isExpandable(header) && reaches(header)) header.setExpanded(expanded);
			for (const container of [host.loadedResourcesContainer, host.chatContainer]) {
				for (const child of container.children) if (isExpandable(child) && reaches(child)) child.setExpanded(expanded);
			}
		}),
		watchSelection(store, selectHideThinking, (hide) => {
			forEachAssistantMessage(host.chatContainer, (message) => message.setHideThinkingBlock(hide));
		}),
		watchSelection(store, selectOutputPad, (pad) => {
			for (const container of [host.chatContainer, host.pendingMessagesContainer])
				for (const child of container.children)
					if ("setOutputPad" in child && typeof child.setOutputPad === "function") child.setOutputPad(pad);
		}),
		watchSelection(store, selectNotice, (notice) => {
			if (notice) host.showStatus(notice.text);
		}),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
