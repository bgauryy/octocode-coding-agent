import type { FeatureContext } from "../../../core/features/index.ts";
import type { HookEvent } from "../catalog.ts";
import type { Dispatch, HookSession, ReportFailure } from "./types.ts";

export interface HookObserver {
	/**
	 * Runs the hooks of `event` in the background under the presence deadline (1.5 s, raised to the longest configured
	 * hook timeout, at most 60 s); `name` is what the matcher tests and `build` makes the input. `skip` is checked just
	 * before dispatch. Nothing runs when no hook is configured for the event.
	 */
	observe(
		event: HookEvent,
		name: string,
		build: () => Record<string, unknown>,
		ctx: FeatureContext,
		skip?: () => boolean,
	): void;
	/** Waits for the hooks it started; each stops at its own deadline, so the wait is bounded. */
	settled(): Promise<unknown>;
}

/**
 * The observe-only dispatch the background hook events share: a failure other than the deadline abort is reported, and
 * shutdown waits on `settled()`. With `defer`, dispatch starts one turn of the event loop after `observe` returns.
 */
export function hookObserver(
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
	{ defer }: { defer: boolean },
): HookObserver {
	const pending = new Set<Promise<void>>();
	return {
		observe(event, name, build, ctx, skip) {
			const groups = session.config[event];
			if (groups.length === 0) return;
			const budget = Math.min(
				60_000,
				Math.max(1500, ...groups.flatMap((group) => group.hooks.map((hook) => hook.timeoutMs))),
			);
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), budget);
			const send = () => (skip?.() ? undefined : dispatch(ctx, event, [name], build, abort.signal, ["octocode"]));
			const done: Promise<void> = (defer ? Promise.resolve().then(send) : Promise.resolve(send()))
				.then(() => undefined)
				.catch((error: unknown) => {
					if (!abort.signal.aborted) reportFailure(ctx, event, error);
				})
				.finally(() => {
					clearTimeout(timer);
					pending.delete(done);
				});
			pending.add(done);
		},
		settled: () => Promise.allSettled(pending),
	};
}
