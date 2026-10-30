/**
 * State binding for components: a view reads a selection of a state source and asks for a frame only when that
 * selection changes. Any `{ getState, subscribe }` holder fits, including a Zustand vanilla store, so the library
 * keeps no state-management dependency.
 */

import type { Component } from "./tui.ts";

/** A readable state holder that notifies after each change. */
export interface StateSource<S> {
	getState(): S;
	subscribe(listener: () => void): () => void;
}

export type Equality<T> = (a: T, b: T) => boolean;

/** Shallow equality for arrays and plain objects: equal when every element or own property is `Object.is`-equal. */
export function shallowEqual<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a);
	if (keysA.length !== Object.keys(b).length) return false;
	return keysA.every(
		(key) =>
			Object.hasOwn(b, key) && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	);
}

/**
 * Calls `onChange(next, previous)` when `select(state)` changes by `equals` (default `Object.is`); unrelated state
 * changes are ignored. Returns the unsubscribe function.
 */
export function watchSelection<S, T>(
	source: StateSource<S>,
	select: (state: S) => T,
	onChange: (next: T, previous: T) => void,
	equals: Equality<T> = Object.is,
): () => void {
	let current = select(source.getState());
	return source.subscribe(() => {
		const next = select(source.getState());
		if (equals(next, current)) return;
		const previous = current;
		current = next;
		onChange(next, previous);
	});
}

export interface ConnectedOptions<S, T> {
	source: StateSource<S>;
	select: (state: S) => T;
	/** Lines for a selection at a width; called only when either changed or after `invalidate` (a theme change). */
	view: (value: T, width: number) => string[];
	/** Asks the renderer for a frame; the renderer coalesces requests. */
	requestRender: () => void;
	equals?: Equality<T>;
}

/** A component drawn from a selection of state: cached per selection and width, repainted only when they change. */
export class Connected<S, T> implements Component {
	private readonly options: ConnectedOptions<S, T>;
	private value: T;
	private cached: { width: number; lines: string[] } | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(options: ConnectedOptions<S, T>) {
		this.options = options;
		this.value = options.select(options.source.getState());
		this.unsubscribe = watchSelection(
			options.source,
			options.select,
			(next) => {
				this.value = next;
				this.cached = undefined;
				options.requestRender();
			},
			options.equals,
		);
	}

	render(width: number): string[] {
		if (this.cached?.width !== width) this.cached = { width, lines: this.options.view(this.value, width) };
		return this.cached.lines;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	/** Stops following the source; the last lines stay drawable. */
	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
