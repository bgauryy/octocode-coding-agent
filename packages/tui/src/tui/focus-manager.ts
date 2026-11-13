import { type Component, isFocusable, type TuiMouseDispatchTarget } from "./component.ts";
import { Container } from "./container.ts";
import { containerStructureVersion, readChildren } from "./container-state.ts";
import { createOverlayHandle } from "./overlay-handle.ts";
import type {
	BlockedOverlayFocusRestoreState,
	OverlayFocusRestorePolicy,
	OverlayFocusRestoreState,
	OverlayHandle,
	OverlayOptions,
	OverlayStackEntry,
} from "./overlay-types.ts";

/** What the focus manager needs from the TUI that owns it. */
export interface FocusHost {
	/** Terminal size, passed to overlay `visible` callbacks. */
	viewport(): { columns: number; rows: number };
	/** Roots whose subtrees count as mounted; subclasses may host the tree elsewhere than `children`. */
	mountedRoots(): readonly Component[];
	requestRender(): void;
	/** Hide the cursor while overlays open or close. */
	hideCursor(): void;
}

/**
 * Keyboard focus and the overlay stack. Overlays take focus when shown and give it back when
 * hidden, so focus changes and overlay changes share one state machine.
 */
export class FocusManager {
	private focused: Component | null = null;
	/** Tracks focus owners once mounted, so later removals cannot receive keyboard input. */
	private readonly mountedFocusOwners = new WeakSet<Component>();
	/**
	 * The focused component the last tree walk did not find (an overlay, a detached widget), the roots it walked and
	 * the containers' structure version then: until a children list may have changed, walking again finds nothing.
	 */
	private unmountedFocus: { component: Component; roots: readonly Component[]; version: number } | undefined;
	private focusOrderCounter = 0;
	/** Overlays for modal components rendered on top of base content. */
	readonly stack: OverlayStackEntry[] = [];
	/** Pending return of focus to an overlay. Read and written by the overlay handles. */
	focusRestore: OverlayFocusRestoreState = { status: "inactive" };

	readonly host: FocusHost;

	constructor(host: FocusHost) {
		this.host = host;
	}

	get focusedComponent(): Component | null {
		return this.focused;
	}

	nextFocusOrder(): number {
		return ++this.focusOrderCounter;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focused;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.stack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.stack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedFocusResume(restoreState);
				} else {
					this.focusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.focusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearFocusRestore();
			}
		}
		if (nextFocus && !this.stack.some((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))) {
			if (this.isDetachedFocusOwner(nextFocus)) nextFocus = null;
		}

		if (isFocusable(this.focused)) {
			this.focused.focused = false;
		}

		this.focused = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.stack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.focusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	clearFocusRestore(): void {
		this.focusRestore = { status: "inactive" };
	}

	clearFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.focusRestore.status !== "inactive" && this.focusRestore.overlay === overlay) {
			this.clearFocusRestore();
		}
	}

	private resolveBlockedFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.focusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.stack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.stack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	retargetPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.stack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	isComponentMounted(component: Component): boolean {
		return this.host.mountedRoots().findLast((child) => this.containsComponent(child, component)) !== undefined;
	}

	/** A retained mouse gesture must not outlive its component or visible overlay. */
	isMouseTargetMounted(target: TuiMouseDispatchTarget): boolean {
		let component = target.component;
		for (const owner of target.owners ?? []) {
			// An opaque forwarding wrapper owns the target it returned; Container exposes its
			// live children, so a child removed after press can be rejected before release.
			if (owner instanceof Container && readChildren(owner)?.includes(component) === false) return false;
			component = owner;
		}
		return (
			this.isComponentMounted(component) ||
			this.stack.some((entry) => this.isOverlayVisible(entry) && this.containsComponent(entry.component, component))
		);
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		// Read without counting as an edit: an edit would make every container on the way walk its children next frame.
		const children = readChildren(root) ?? root.children;
		// Last child first: this runs on every key for the focused component, which is the editor below the transcript,
		// so it is found before the walk enters the transcript's rows.
		for (let index = children.length - 1; index >= 0; index--)
			if (this.containsComponent(children[index], target)) return true;
		return false;
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focused,
			hidden: false,
			focusOrder: this.nextFocusOrder(),
		};
		this.stack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.host.hideCursor();
		this.host.requestRender();

		return createOverlayHandle(this, entry);
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.stack[this.stack.length - 1];
		if (!overlay) return;
		this.clearFocusRestoreFor(overlay);
		this.retargetPreFocus(overlay);
		this.stack.pop();
		if (this.focused === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.stack.length === 0) this.host.hideCursor();
		this.host.requestRender();
	}

	/** Check if there are any visible overlays */
	hasVisibleOverlay(): boolean {
		return this.stack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if the focused component is a visible overlay */
	isOverlayFocused(): boolean {
		return this.stack.some((entry) => entry.component === this.focused && this.isOverlayVisible(entry));
	}

	/** Keep overlay containers as keyboard focus owners when a nested control is clicked. */
	resolveMouseFocusTarget(component: Component): Component {
		for (let index = this.stack.length - 1; index >= 0; index--) {
			const overlay = this.stack[index];
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		return component;
	}

	isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			const { columns, rows } = this.host.viewport();
			return entry.options.visible(columns, rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.stack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	/** Remember a focused component that is mounted, so its later removal is noticed. */
	rememberMountedFocus(): void {
		// Called on every render request: once a component is remembered, another tree walk adds nothing.
		const focused = this.focused;
		if (!focused || this.mountedFocusOwners.has(focused)) return;
		// An overlay is drawn from the stack, not mounted in the tree (one in both is not supported): nothing to remember.
		if (this.stack.some((entry) => entry.component === focused)) return;
		// A focused overlay is never in the tree: walk it again only after a children list may have changed.
		const roots = this.host.mountedRoots();
		const version = containerStructureVersion();
		const missed = this.unmountedFocus;
		if (missed?.component === focused && missed.version === version && sameRoots(missed.roots, roots)) return;
		this.unmountedFocus = undefined;
		if (this.isComponentMounted(focused)) this.mountedFocusOwners.add(focused);
		else this.unmountedFocus = { component: focused, roots: roots.slice(), version };
	}

	/**
	 * Whether the component was mounted when focus last saw it and no longer is. A mounted component
	 * is remembered as a focus owner; a component that never was mounted (a detached widget the
	 * caller focused on purpose) keeps its focus.
	 */
	private isDetachedFocusOwner(component: Component): boolean {
		if (this.isComponentMounted(component)) {
			this.mountedFocusOwners.add(component);
			return false;
		}
		return this.mountedFocusOwners.has(component);
	}

	/**
	 * Repair focus before input is delivered, in order: leave a focused overlay that stopped being
	 * visible, return to an overlay whose focus was taken or is owed back, and drop a mounted
	 * component that left the tree.
	 */
	reconcileFocus(): void {
		// Overlay visibility can change with a terminal resize or a visible() callback.
		const focusedOverlay = this.stack.find((o) => o.component === this.focused);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.stack.some((o) => o.component === this.focused);
		if (focusIsOverlay) return;
		const restoreState = this.getVisibleFocusRestore();
		if (restoreState.status === "eligible") {
			this.setFocus(restoreState.overlay.component);
		} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focused) {
			if (restoreState.resume.status === "restore-overlay") {
				this.setFocus(restoreState.overlay.component);
			} else {
				this.clearFocusRestore();
				this.setFocus(restoreState.resume.target);
			}
		}
		if (this.focused && this.isDetachedFocusOwner(this.focused)) this.setFocus(null);
	}
}

function sameRoots(a: readonly Component[], b: readonly Component[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}
