import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "./component.ts";
import { renderIsolated } from "./render-isolation.ts";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];
	private renderCache?: { width: number; components: Component[]; arrays: string[][]; lines: string[] };
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		this.renderCache = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const mouseChildren =
			this.mouseLayout?.width === event.width
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(event.width).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (event.y >= childY && event.y < childY + childHeight) {
				// Keep the last painted positions until redraw, but never activate a detached child.
				if (!this.children.includes(child)) return undefined;
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	/**
	 * Concatenate the children's rows. When the width and every child's returned array are the same
	 * references as last frame, the previous result is returned, so parents and the frame diff can
	 * rely on identity. A child that returns a new array makes a new result.
	 */
	render(width: number): string[] {
		const previous = this.renderCache;
		const children = this.children;
		const arrays: string[][] = [];
		let same = previous?.width === width && previous.components.length === children.length;
		for (const [i, child] of children.entries()) {
			const childLines = renderIsolated(child, width);
			arrays.push(childLines);
			if (same && (previous?.components[i] !== child || previous.arrays[i] !== childLines)) same = false;
		}
		if (same && previous) return previous.lines;
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const [i, child] of children.entries()) {
			const childLines = arrays[i] ?? [];
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) lines.push(line);
		}
		this.mouseLayout = { width, children: mouseChildren };
		this.renderCache = { width, components: children.slice(), arrays, lines };
		return lines;
	}
}
