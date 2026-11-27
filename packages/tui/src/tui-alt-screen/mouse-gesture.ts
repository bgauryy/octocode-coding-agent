import type { LayoutFrame } from "../layout/types.ts";
import { getLayoutBoxesAt } from "../layout.ts";
import { getLayoutNode } from "../layout-node.ts";
import type { Terminal } from "../terminal.ts";
import {
	type Component,
	dispatchMouseEvent,
	retargetMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
} from "../tui/component.ts";
import { Container } from "../tui/container.ts";
import { DOUBLE_CLICK_INTERVAL_MS } from "./constants.ts";
import { decodeMouseButton } from "./mouse-input.ts";
import type { SgrMouseEvent } from "./types.ts";

/** A component under a screen cell and the rect it was painted at. */
export interface LayoutHit {
	component: Component;
	rect: { x: number; y: number; width: number; height: number };
}

/** Alternate-screen state and focus operations the component mouse dispatch reads and calls live. */
export interface AltScreenMouseGestureHost {
	getTerminal(): Terminal;
	getCurrentLayout(): LayoutFrame | undefined;
	isMouseTargetMounted(target: TuiMouseDispatchTarget): boolean;
	resolveMouseFocusTarget(component: Component): Component;
	getFocusedComponent(): Component | null;
	setFocus(component: Component | null): void;
	requestRender(): void;
}

/**
 * Component mouse dispatch: hit-testing the layout, focus and render results, and the press,
 * capture and synthesized-click gesture of the component that received the press.
 */
export class AltScreenMouseGesture {
	/**
	 * Whether a retained target painted through the implicit document (which forwards into the screen's own children
	 * without owning a child list) is still mounted; undefined when the target was not painted through it.
	 */
	static implicitTargetMounted(
		target: TuiMouseDispatchTarget,
		implicitDocument: Component,
		implicitShown: boolean,
		children: readonly Component[],
	): boolean | undefined {
		const owners = target.owners ?? [];
		const implicitIndex = owners.indexOf(implicitDocument);
		if (implicitIndex < 0) return undefined;
		if (!implicitShown) return false;
		let component = target.component;
		for (const owner of owners.slice(0, implicitIndex)) {
			if (owner instanceof Container && !owner.children.includes(component)) return false;
			component = owner;
		}
		// Keep the painted coordinates, but require a live child.
		return children.includes(component);
	}

	private mouseCapture?: TuiMouseDispatchTarget;
	private mousePressTarget?: TuiMouseDispatchTarget;
	private mousePressPoint?: { x: number; y: number };
	private mousePressMoved = false;
	lastComponentClick?: {
		timestamp: number;
		count: number;
		component: Component;
		x: number;
		y: number;
	};
	private readonly host: AltScreenMouseGestureHost;

	constructor(host: AltScreenMouseGestureHost) {
		this.host = host;
	}

	clearComponentMouseGesture(): void {
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressMoved = false;
	}

	/** Remember the component that received a press, so release can synthesize its click. */
	startComponentMouseGesture(target: TuiMouseDispatchTarget, x: number, y: number): void {
		this.mousePressTarget = target;
		this.mousePressPoint = { x, y };
		this.mousePressMoved = false;
	}

	createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "wheel" ? "none" : decodeMouseButton(button),
			x,
			y,
			screenX: x,
			screenY: y,
			width: Math.max(1, this.host.getTerminal().columns),
			height: Math.max(1, this.host.getTerminal().rows),
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	/** The components under a screen cell with their painted rects, as they are now. */
	hitLayoutAt(x: number, y: number): LayoutHit[] {
		const currentLayout = this.host.getCurrentLayout();
		if (!currentLayout) return [];
		return getLayoutBoxesAt(currentLayout, x, y).map((box) => ({
			component: box.component,
			rect: { ...box.rect },
		}));
	}

	/**
	 * Offer the event to the components of `hits` (default: those under the event's cell now), innermost first. A press
	 * remembers its hits, so a click lands on the component that was pressed although content moved before release.
	 */
	dispatchMouseToLayout(
		event: TuiMouseEvent,
		hits: readonly LayoutHit[] = this.hitLayoutAt(event.screenX, event.screenY),
	): TuiMouseDispatchResult | undefined {
		const visited = new Set<Component>();
		for (const box of hits) {
			if (visited.has(box.component)) continue;
			if (getLayoutNode(box.component) && box.component.handleMouse === Container.prototype.handleMouse) continue;
			visited.add(box.component);
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y,
				width: box.rect.width,
				height: box.rect.height,
			});
			if (result) return result;
		}
		return undefined;
	}

	applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const focusTarget = this.host.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		const focusChanged = result.focus === true && this.host.getFocusedComponent() !== focusTarget;
		if (result.focus) this.host.setFocus(focusTarget);
		if (result.capture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	private dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	private getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		const now = Date.now();
		const previous = this.lastComponentClick;
		const count =
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.component === target.component &&
			previous.x === x &&
			previous.y === y
				? (previous.count % 3) + 1
				: 1;
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		return count;
	}

	/**
	 * Route an event to the component that captured the mouse or received the press.
	 * Returns false when no component gesture is active.
	 */
	handleComponentMouseGesture(raw: SgrMouseEvent, event: TuiMouseEvent): boolean {
		if (!(this.mouseCapture || this.mousePressTarget)) return false;
		const target = this.mouseCapture ?? this.mousePressTarget!;
		if (
			!this.host.isMouseTargetMounted(target) ||
			(this.mousePressTarget && !this.host.isMouseTargetMounted(this.mousePressTarget))
		) {
			this.clearComponentMouseGesture();
			this.lastComponentClick = undefined;
			return true;
		}
		// Jitter that returns to the press cell is still a click: only where the pointer is now counts.
		this.mousePressMoved =
			this.mousePressPoint !== undefined && (raw.x !== this.mousePressPoint.x || raw.y !== this.mousePressPoint.y);
		if (this.mousePressMoved) this.lastComponentClick = undefined;
		let render = false;
		const targetResult = this.dispatchMouseToTarget(event, target);
		if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
		if (raw.release) {
			if (
				this.host.isMouseTargetMounted(target) &&
				!this.mousePressMoved &&
				this.mousePressPoint?.x === raw.x &&
				this.mousePressPoint.y === raw.y
			) {
				const clickEvent = this.createMouseEvent("click", raw.button, raw.x, raw.y, {
					clickCount: this.getComponentClickCount(target, raw.x, raw.y),
				});
				const clickResult = this.dispatchMouseToTarget(clickEvent, target);
				if (clickResult) render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
			}
			this.clearComponentMouseGesture();
		}
		if (render) this.host.requestRender();
		return true;
	}
}
