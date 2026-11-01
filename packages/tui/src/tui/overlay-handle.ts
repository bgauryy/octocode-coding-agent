import type { Component } from "./component.ts";
import type { OverlayFocusRestoreState, OverlayHandle, OverlayStackEntry } from "./overlay-types.ts";

/** The part of the focus manager (`FocusManager` in focus-manager.ts) an overlay handle drives. */
interface OverlayFocusOwner {
	readonly stack: OverlayStackEntry[];
	readonly host: { requestRender(): void; hideCursor(): void };
	readonly focusedComponent: Component | null;
	focusRestore: OverlayFocusRestoreState;
	setFocus(component: Component | null): void;
	nextFocusOrder(): number;
	clearFocusRestore(): void;
	clearFocusRestoreFor(overlay: OverlayStackEntry): void;
	retargetPreFocus(removed: OverlayStackEntry): void;
	isOverlayVisible(entry: OverlayStackEntry): boolean;
	getTopmostVisibleOverlay(): OverlayStackEntry | undefined;
}

/** The handle `showOverlay` returns: controls one overlay entry through the focus manager that owns it. */
export function createOverlayHandle(focus: OverlayFocusOwner, entry: OverlayStackEntry): OverlayHandle {
	const { component, options } = entry;
	const { stack, host } = focus;
	return {
		hide: () => {
			const index = stack.indexOf(entry);
			if (index !== -1) {
				focus.clearFocusRestoreFor(entry);
				focus.retargetPreFocus(entry);
				stack.splice(index, 1);
				// Restore focus if this overlay had focus
				if (focus.focusedComponent === component) {
					const topVisible = focus.getTopmostVisibleOverlay();
					focus.setFocus(topVisible?.component ?? entry.preFocus);
				}
				if (stack.length === 0) host.hideCursor();
				host.requestRender();
			}
		},
		setHidden: (hidden: boolean) => {
			if (entry.hidden === hidden) return;
			entry.hidden = hidden;
			// Update focus when hiding/showing
			if (hidden) {
				focus.clearFocusRestoreFor(entry);
				// If this overlay had focus, move focus to next visible or preFocus
				if (focus.focusedComponent === component) {
					const topVisible = focus.getTopmostVisibleOverlay();
					focus.setFocus(topVisible?.component ?? entry.preFocus);
				}
			} else {
				// Restore focus to this overlay when showing (if it's actually visible)
				if (!options?.nonCapturing && focus.isOverlayVisible(entry)) {
					entry.focusOrder = focus.nextFocusOrder();
					focus.setFocus(component);
				}
			}
			host.requestRender();
		},
		isHidden: () => entry.hidden,
		focus: () => {
			if (!stack.includes(entry) || !focus.isOverlayVisible(entry)) return;
			entry.focusOrder = focus.nextFocusOrder();
			focus.setFocus(component);
			host.requestRender();
		},
		unfocus: (unfocusOptions) => {
			const isFocused = focus.focusedComponent === component;
			const restoreState = focus.focusRestore;
			const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
			if (!isFocused && !hasPendingRestore) return;
			if (
				restoreState.status === "blocked" &&
				restoreState.overlay === entry &&
				focus.focusedComponent === restoreState.blockedBy
			) {
				if (unfocusOptions) {
					focus.focusRestore = {
						status: "blocked",
						overlay: entry,
						blockedBy: restoreState.blockedBy,
						resume: { status: "focus-target", target: unfocusOptions.target },
					};
				} else {
					focus.clearFocusRestore();
				}
				host.requestRender();
				return;
			}
			focus.clearFocusRestoreFor(entry);
			if (isFocused || unfocusOptions) {
				const topVisible = focus.getTopmostVisibleOverlay();
				const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
				focus.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
			}
			host.requestRender();
		},
		isFocused: () => focus.focusedComponent === component,
		getBounds: () => {
			if (!stack.includes(entry) || !focus.isOverlayVisible(entry) || !entry.bounds) return undefined;
			return { ...entry.bounds };
		},
	};
}
