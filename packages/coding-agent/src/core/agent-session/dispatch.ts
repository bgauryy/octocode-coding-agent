import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface Dispatch {
	id: string;
	owner: object;
	controller: AbortController;
	pending: Set<Promise<unknown>>;
	/** The first failure, boxed so a thrown `undefined` or `null` still counts. */
	failure?: { error: unknown };
	open: boolean;
}
interface Activity {
	count: number;
	dispatches: Set<Dispatch>;
}
const current = new AsyncLocalStorage<Dispatch>();
const activities = new WeakMap<object, Activity>();

function activity(owner: object): Activity {
	let state = activities.get(owner);
	if (!state) {
		state = { count: 0, dispatches: new Set() };
		activities.set(owner, state);
	}
	return state;
}

function dispatch(owner: object, id: string = randomUUID()): Dispatch {
	return { id, owner, controller: new AbortController(), pending: new Set(), open: true };
}

/** Counts input preparation as work, before model execution exists. Nested feature sends share their caller's scope. */
export function trackSessionDispatch<T>(
	owner: object,
	operation: () => Promise<T>,
	changed: (active: boolean, dispatchId: string) => void,
): Promise<T> {
	const inherited = current.getStore();
	if (inherited?.owner === owner) inherited.controller.signal.throwIfAborted();
	const scope = inherited?.owner === owner && inherited.open ? inherited : dispatch(owner);
	const state = activity(owner);
	state.dispatches.add(scope);
	if (state.count++ === 0) changed(true, scope.id);
	let pending: Promise<T>;
	try {
		pending = current.run(scope, operation);
	} catch (error) {
		pending = Promise.reject(error);
	}
	scope.pending.add(pending);
	const finished = () => {
		scope.pending.delete(pending);
		if (scope.pending.size === 0) {
			scope.open = false;
			state.dispatches.delete(scope);
		}
		if (--state.count === 0) changed(false, scope.id);
	};
	void pending.then(finished, (error) => {
		scope.failure ??= { error };
		finished();
	});
	return pending;
}

export function hasSessionDispatch(owner: object): boolean {
	return (activities.get(owner)?.count ?? 0) > 0;
}

export function checkSessionDispatch(owner: object): void {
	const scope = current.getStore();
	if (scope?.owner === owner) scope.controller.signal.throwIfAborted();
}

/** Settlement may deliver a new task after interruption; it must not inherit the cancelled task's signal. */
export function settleSessionDispatch(owner: object, operation: () => Promise<void>): Promise<void> {
	const scope = current.getStore();
	return scope?.owner === owner && scope.controller.signal.aborted
		? completeSessionDispatch(owner, operation)
		: operation();
}

/** Internal controls can stop other work without cancelling the command that is requesting that stop. */
export function abortSessionDispatches(owner: object): void {
	const caller = current.getStore();
	for (const scope of activities.get(owner)?.dispatches ?? []) {
		if (scope !== caller) scope.controller.abort(new Error("Prompt dispatch cancelled"));
	}
}

/** Wait for all work the command actually dispatched, including asynchronous feature preflight and nested sends. */
export async function completeSessionDispatch(
	owner: object,
	operation: () => Promise<void>,
	id?: string,
): Promise<void> {
	const scope = dispatch(owner, id);
	try {
		try {
			await current.run(scope, operation);
		} catch (error) {
			scope.failure ??= { error };
		}
		while (scope.pending.size > 0) await Promise.allSettled(scope.pending);
		if (scope.failure) throw scope.failure.error;
		scope.controller.signal.throwIfAborted();
	} finally {
		scope.open = false;
	}
}
