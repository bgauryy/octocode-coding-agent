import {
	type Component,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui/component.ts";
import {
	isRenderStable,
	linkRenderChild,
	renderChanged,
	renderSerial,
	settleRender,
	trackRenderChanges,
} from "../tui/render-signal.ts";

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
export class MouseRegion implements Component {
	private readonly child: Component;
	private readonly onMouse: MouseRegionHandler;

	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.child = child;
		this.onMouse = onMouse;
		linkRenderChild(this, child);
	}

	render(width: number): string[] {
		linkRenderChild(this, this.child);
		const before = renderSerial();
		const lines = this.child.render(width);
		settleRender(this, isRenderStable(this.child, before));
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		const childResult = dispatchMouseEvent(this.child, event);
		return childResult ?? this.onMouse(event);
	}

	invalidate(): void {
		this.child.invalidate();
		renderChanged(this);
	}
}

trackRenderChanges(MouseRegion.prototype);
