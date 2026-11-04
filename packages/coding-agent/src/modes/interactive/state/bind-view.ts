/**
 * Binds the view slice to the component tree: expansion and thinking visibility reach the live rows, and the
 * notice reaches the footer. Writers only dispatch actions; `bindRender` requests the frame.
 */

import { watchSelection } from "@octocodeai/octocode-tui";
import { isExpandable } from "../interactive-mode/helpers.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { forEachAssistantMessage } from "./assistant-messages.ts";
import { selectHideThinking, selectNotice, selectToolsExpanded } from "./view-slice.ts";

const NOTICE_KEY = "notice";

type BindViewHost = Pick<
	InteractiveModeHost,
	"builtInHeader" | "chatContainer" | "customHeader" | "footerDataProvider" | "loadedResourcesContainer" | "uiStore"
>;

/** Starts following the view slice; returns the function that stops it. */
export function bindViewState(host: BindViewHost): () => void {
	const { uiStore: store } = host;
	const stops = [
		watchSelection(store, selectToolsExpanded, (expanded) => {
			const header = host.customHeader ?? host.builtInHeader;
			if (isExpandable(header)) header.setExpanded(expanded);
			for (const container of [host.loadedResourcesContainer, host.chatContainer]) {
				for (const child of container.children) if (isExpandable(child)) child.setExpanded(expanded);
			}
		}),
		watchSelection(store, selectHideThinking, (hide) => {
			forEachAssistantMessage(host.chatContainer, (message) => message.setHideThinkingBlock(hide));
		}),
		watchSelection(store, selectNotice, (notice) => {
			host.footerDataProvider.setExtensionStatus(NOTICE_KEY, notice?.text);
		}),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
