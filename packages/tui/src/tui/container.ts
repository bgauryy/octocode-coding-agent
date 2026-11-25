import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "./component.ts";
import {
	ContainerRenderState,
	noteStructureChange,
	registerContainerPrototype,
	registerContainerState,
} from "./container-state.ts";
import { renderContainer } from "./container-walk.ts";
import { frameLines } from "./row-source.ts";
import {
	CHILD_RENDER_CHANGED,
	linkRenderChild,
	markRenderComposite,
	relinkRenderChildren,
	renderChanged,
	trackRenderChanges,
} from "./render-signal.ts";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	static {
		// A child container hands its parent its rows as a row frame; the walk reads the children list from here.
		registerContainerPrototype(Container.prototype, (container) => (container as Container).#childList);
	}

	// Engine-private (`#`): subclasses define their own members freely (several have a `signal`).
	#childList: Component[] = [];
	readonly #renderState = new ContainerRenderState();

	constructor() {
		registerContainerState(this, this.#renderState);
		markRenderComposite(this);
	}

	/**
	 * The children, in render order. Reading the array counts as a change to it: code may edit it in place
	 * (`children.splice(...)`), so the next frame walks every child once. Only until that frame: an array kept and edited
	 * after a render is not seen (read `children` again for each edit).
	 */
	get children(): Component[] {
		this.#structureChanged();
		return this.#childList;
	}

	set children(children: Component[]) {
		this.#replaceChildren(children);
	}

	addChild(component: Component): void {
		this.#childList.push(component);
		linkRenderChild(this, component);
		this.#structureChanged();
	}

	removeChild(component: Component): void {
		const index = this.#childList.indexOf(component);
		if (index !== -1) {
			this.#childList.splice(index, 1);
			if (!this.#childList.includes(component)) this.#unlinked(relinkRenderChildren(this, [component], []));
			this.#structureChanged();
		}
	}

	/** Read-only view of the children in render order without marking structure changed. */
	peekChildren(): readonly Component[] {
		return this.#childList;
	}

	clear(): void {
		this.#replaceChildren([]);
		this.#renderState.frame = undefined;
		this.#renderState.dirty = undefined;
		this.#renderState.painted = undefined;
	}

	/** Every edit of the list links the children it renders and marks those it unlinked (`relinkRenderChildren`). */
	#replaceChildren(children: Component[]): void {
		this.#unlinked(relinkRenderChildren(this, this.#childList, children));
		this.#childList = children;
		this.#structureChanged();
	}

	/**
	 * Children this container stopped rendering: their signals reach nobody until they are linked again, so one that comes
	 * back (removed, changed, added again at its old place) renders again instead of keeping its last rows.
	 */
	#unlinked(children: readonly Component[]): void {
		if (children.length === 0) return;
		this.#renderState.dirty ??= new Set();
		for (const child of children) this.#renderState.dirty.add(child);
	}

	/** This container's last frame, when it keeps one (diagnostics and tests read it). */
	private get renderCache(): { readonly width: number; readonly lines: readonly string[] | undefined } | undefined {
		const frame = this.#renderState.frame;
		return frame && { width: frame.width, lines: frame.rows.lines };
	}

	/**
	 * Drop this container's own copy of its children's rows, keeping theirs: a frame that draws the children one by one
	 * (a virtualized scroll view) never reads it, and it would hold a second array of every row in the transcript. Where
	 * the children were painted stays.
	 */
	releaseRenderCache(): void {
		this.#renderState.frame = undefined;
	}

	invalidate(): void {
		this.#renderState.frame = undefined;
		for (const child of this.#childList) {
			child.invalidate?.();
		}
		this.#signal();
	}

	/** A linked child signalled: render it again next frame, and tell the parents once. */
	[CHILD_RENDER_CHANGED](child: Component): void {
		(this.#renderState.dirty ??= new Set()).add(child);
		this.#signal();
	}

	#structureChanged(): void {
		noteStructureChange();
		this.#renderState.structureChanged = true;
		this.#signal();
	}

	#signal(): void {
		if (this.#renderState.signaled) return;
		this.#renderState.signaled = true;
		renderChanged(this);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const painted = this.#renderState.painted?.width === event.width ? this.#renderState.painted : undefined;
		const components = painted?.components ?? this.#childList;
		let childY = 0;
		for (let i = 0; i < components.length; i++) {
			const child = components[i];
			const childHeight = painted ? painted.offsets[i + 1] - painted.offsets[i] : child.render(event.width).length;
			if (event.y >= childY && event.y < childY + childHeight) {
				// Keep the last painted positions until redraw, but never activate a detached child.
				if (!this.#childList.includes(child)) return undefined;
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
	 * The children's rows in order. While the width and every child's rows are the same as last frame, the previous
	 * array is returned, so parents and the frame diff can rely on identity. Children that track their changes
	 * (`trackRenderChanges`) and did not signal are not rendered at all; a child container hands over its rows without
	 * joining them, and a changed tail copies the rows before it once. Results are never mutated after they are returned.
	 */
	render(width: number): string[] {
		return frameLines(renderContainer(this, this.#renderState, this.#childList, width).rows);
	}
}

trackRenderChanges(Container.prototype);
