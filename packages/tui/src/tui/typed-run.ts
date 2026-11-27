import type { Component } from "./component.ts";
import { isolateInput } from "./input-listeners.ts";
import { isTypedRun } from "../stdin-buffer/typed-run.ts";

/** What routing a typed run needs from the TUI: the steps every key takes, split where a run can join them. */
export interface TypedRunRouter {
	/** Terminal replies and input listeners: the input left for the focused component, if any. */
	route(data: string): string | undefined;
	/** Runs the debug handler when `data` is its key; true when it did. */
	debugKey(data: string): boolean;
	/** The focused component after focus is reconciled. */
	focused(): Component | null | undefined;
	/** Hands one key to the focused component. */
	deliver(data: string): void;
	/** Hands typed characters to `component` in one call; returns what `handleTextRun` returned. */
	deliverRun(component: Component, text: string): number;
}

/** One input event: replies and listeners, the debug key, focus, then the focused component. */
export function routeKey(router: TypedRunRouter, received: string): void {
	const data = router.route(received);
	if (data === undefined || router.debugKey(data)) return;
	router.focused();
	router.deliver(data);
}

/**
 * Deliver typed characters that already passed replies, listeners and the debug key: to `component` in one call, then
 * whatever it left to the component focused after its last key (that key may have opened a selector or overlay), in
 * runs to a component with `handleTextRun` and one key at a time to any other.
 */
function deliverTyped(router: TypedRunRouter, component: Component, text: string): void {
	let target: Component | null | undefined = component;
	let rest = text;
	while (rest) {
		const current = rest;
		const runTo = target;
		let used = 0;
		if (runTo?.handleTextRun) {
			let threw = true;
			isolateInput(() => {
				used = router.deliverRun(runTo, current);
				threw = false;
			});
			// As for a single key: a component that throws loses that input.
			if (threw) return;
		}
		// A component without `handleTextRun`, or one that handled nothing, gets the next key alone.
		if (!(used > 0 && used <= current.length)) {
			used = String.fromCodePoint(current.codePointAt(0)!).length;
			const key = current.slice(0, used);
			isolateInput(() => router.deliver(key));
		}
		rest = current.slice(used);
		if (rest) target = router.focused();
	}
}

/**
 * Printable characters from one terminal read. Each is routed as its own key (replies, listeners, debug key, focus),
 * each isolated as its own input event; consecutive ones that reach a focused component with `handleTextRun` arrive
 * there in one call, the rest one by one. Listeners see every key of such a run before the component does.
 */
export function routeTypedRun(router: TypedRunRouter, received: string): void {
	let run = "";
	let target: Component | undefined;
	const flush = () => {
		const component = target;
		const text = run;
		run = "";
		target = undefined;
		if (text && component) deliverTyped(router, component, text);
	};
	for (const char of received) {
		isolateInput(() => {
			const data = router.route(char);
			if (data === undefined) return;
			if (router.debugKey(data)) {
				flush();
				return;
			}
			const focused = router.focused();
			if (focused?.handleTextRun && isTypedRun(data, 1)) {
				if (focused !== target) flush();
				target = focused;
				run += data;
				return;
			}
			flush();
			router.deliver(data);
		});
	}
	flush();
}
