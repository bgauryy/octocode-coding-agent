import { Editor } from "../components/editor.ts";
import type { ScrollView } from "../components/scroll-view.ts";
import { getKeybindings } from "../keybindings.ts";
import { isKeyRelease } from "../keys/sequences.ts";
import type { LayoutFrame } from "../layout/types.ts";
import type { Component } from "../tui/component.ts";
import { getScrollViewBox } from "../layout.ts";
import { OSC133_PROMPT_START } from "../terminal/sequences.ts";
import { PAGE_SCROLL_OVERLAP } from "./constants.ts";
import type { ArrowBurstScroll } from "./arrow-burst.ts";
import type { AltScreenSearchController } from "./search-controller.ts";

/** Alternate-screen viewport operations the keyboard bindings call. */
export interface AltScreenViewportKeysHost {
	readonly search: AltScreenSearchController;
	readonly arrowBurst: ArrowBurstScroll;
	getFocusedComponent(): Component | null;
	getCurrentLayout(): LayoutFrame | undefined;
	getPrimaryScrollView(): ScrollView;
	shouldDeferViewportInputToOverlay(): boolean;
	requestRender(): void;
	scrollBy(lines: number): void;
	scrollToTop(): void;
	scrollToBottom(): void;
	toggleMouseCapture(): void;
}

function scrollToPrompt(host: AltScreenViewportKeysHost, direction: -1 | 1): void {
	const currentLayout = host.getCurrentLayout();
	if (!currentLayout) return;
	const scrollView = host.getPrimaryScrollView();
	const lines = getScrollViewBox(currentLayout, scrollView)?.scrollContentLines;
	if (!lines) return;

	for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
		if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
		scrollView.scrollTo(row);
		host.requestRender();
		return;
	}
}

/** Handle transcript search and viewport scrolling keys; key releases are consumed without acting. */
export function handleViewportKeys(host: AltScreenViewportKeysHost, data: string): { consume?: boolean } | undefined {
	const keybindings = getKeybindings();
	const isRelease = isKeyRelease(data);
	if (keybindings.matches(data, "tui.altScreen.search")) {
		if (!isRelease) host.search.toggleSearch();
		return { consume: true };
	}
	if (host.search.activeSearch?.overlay?.isFocused()) {
		if (keybindings.matches(data, "tui.altScreen.searchNext")) {
			if (!isRelease) host.search.navigateSearch(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
			if (!isRelease) host.search.navigateSearch(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.searchClose")) {
			if (!isRelease) host.search.closeSearch();
			return { consume: true };
		}
	}
	if (host.shouldDeferViewportInputToOverlay()) return undefined;
	if (keybindings.matches(data, "tui.altScreen.toggleMouse")) {
		if (!isRelease) host.toggleMouseCapture();
		return { consume: true };
	}
	// Arrow bursts are a wheel only where arrows recall history: the editor. A selector or dialog keeps its arrows, and
	// so does the editor's open completion list (the `/` menu), where arrows move the selection.
	const focused = host.getFocusedComponent();
	if (!(focused instanceof Editor) || focused.isShowingAutocomplete()) host.arrowBurst.flush();
	else if (host.arrowBurst.handle(data)) return { consume: true };
	if (keybindings.matches(data, "tui.altScreen.pageUp")) {
		if (!isRelease) {
			host.scrollBy(-Math.max(1, host.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
		}
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.pageDown")) {
		if (!isRelease) {
			host.scrollBy(Math.max(1, host.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
		}
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
		if (!isRelease) host.scrollBy(-Math.max(1, Math.floor(host.getPrimaryScrollView().viewportHeight / 2)));
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
		if (!isRelease) host.scrollBy(Math.max(1, Math.floor(host.getPrimaryScrollView().viewportHeight / 2)));
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.lineUp")) {
		if (!isRelease) host.scrollBy(-1);
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.lineDown")) {
		if (!isRelease) host.scrollBy(1);
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
		if (!isRelease) scrollToPrompt(host, -1);
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
		if (!isRelease) scrollToPrompt(host, 1);
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.top")) {
		if (!isRelease) host.scrollToTop();
		return { consume: true };
	}
	if (keybindings.matches(data, "tui.altScreen.bottom")) {
		if (!isRelease) host.scrollToBottom();
		return { consume: true };
	}
	return undefined;
}
