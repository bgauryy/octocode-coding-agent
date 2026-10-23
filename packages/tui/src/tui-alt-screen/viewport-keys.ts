import type { ScrollView } from "../components/scroll-view.ts";
import { getKeybindings } from "../keybindings.ts";
import { isKeyRelease } from "../keys.ts";
import { getScrollViewBox, type LayoutFrame } from "../layout.ts";
import { OSC133_PROMPT_START, PAGE_SCROLL_OVERLAP } from "./constants.ts";
import type { AltScreenSearchController } from "./search-controller.ts";

/** Alternate-screen viewport operations the keyboard bindings call. */
export interface AltScreenViewportKeysHost {
	readonly search: AltScreenSearchController;
	getCurrentLayout(): LayoutFrame | undefined;
	getPrimaryScrollView(): ScrollView;
	shouldDeferViewportInputToOverlay(): boolean;
	requestRender(): void;
	scrollBy(lines: number): void;
	scrollToTop(): void;
	scrollToBottom(): void;
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
