import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where the input being handled came from. Only the terminal carries the user's authority: an ACP or web client confirms
 * a sensitive action (a permission change, a config write, a delete, a push, a spend) in its own client, and typing a
 * command there is never consent.
 */
export type InputOrigin = "terminal" | "acp" | "web" | "rpc";

/** One scope's origin; a run's scope changes it when input from another origin is delivered into the run. */
interface OriginCell {
	origin: InputOrigin;
}

const scope = new AsyncLocalStorage<OriginCell>();
let processOrigin: InputOrigin = "terminal";

/** The origin of the input in progress: the surrounding `withInputOrigin`, else the process's (the terminal unless a host says otherwise). */
export function inputOrigin(): InputOrigin {
	return scope.getStore()?.origin ?? processOrigin;
}

/** Runs `run` (and everything it awaits) as input from `origin`. */
export function withInputOrigin<T>(origin: InputOrigin, run: () => T): T {
	return scope.run({ origin }, run);
}

/**
 * Runs `run` in a scope of its own that starts at the current origin, so `adoptInputOrigin` inside it changes only this
 * run and never the caller's scope.
 */
export function withRunInputOrigin<T>(run: () => T): T {
	return withInputOrigin(inputOrigin(), run);
}

/**
 * Input sent under `origin` is delivered into the run in progress: the work it triggers from here on runs under that
 * origin, so a sensitive action it causes is confirmed in that client. Does nothing outside a scope.
 */
function adoptInputOrigin(origin: InputOrigin): void {
	const cell = scope.getStore();
	if (cell) cell.origin = origin;
}

/**
 * Messages sent from these origins were just delivered into the run: it adopts the least trusted one, so an action they
 * cause is confirmed in that client; when all came from the terminal, the run has the terminal's authority again.
 */
export function adoptDeliveredOrigins(origins: readonly InputOrigin[]): void {
	const origin = origins.find((candidate) => !hasUserAuthority(candidate)) ?? origins[0];
	if (origin) adoptInputOrigin(origin);
}

/** A process that serves only a non-terminal client (an RPC or ACP worker) says so once at start. */
export function setProcessInputOrigin(origin: InputOrigin): void {
	processOrigin = origin;
}

/** Whether the input in progress carries the user's own authority: only the terminal does. */
export function hasUserAuthority(origin: InputOrigin = inputOrigin()): boolean {
	return origin === "terminal";
}
