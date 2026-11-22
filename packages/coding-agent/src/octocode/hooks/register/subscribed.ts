import type { FeatureSetup } from "../../../core/features/index.ts";
import { recordProblem } from "../../../core/diagnostics-log.ts";
import { hookTopic } from "../../events/hook-lifecycle.ts";
import { makeSource } from "../../events/source.ts";
import type { EventSubscribers } from "../../events/subscribers.ts";
import type { AgentEvent } from "../../events/topics.ts";
import type { HookEvent } from "../catalog.ts";
import { commandsFor } from "../config/calls.ts";
import type { HookVerdict } from "../contracts.ts";
import { hookSubscribersOf } from "./subscribers.ts";
import type { Dispatch, HookSession } from "./types.ts";

/**
 * Hook runs as events (RFC agent-event-loop §14 R10). With `runtime.eventLoop: new`, a dispatch that has a configured hook
 * writes a `hook.<Event>` event and the runner starts from the session's `hook:run:<Event>` subscription, whose row names the
 * handler kinds configured for the event. The caller still awaits the very verdict the runner returns, so a deny, a rewrite
 * or a context reaches the tool call, the prompt or the stop exactly as before; the subscription replaces the call, not the
 * answer. Nothing that cannot be started from the subscription is ever dropped: when the event cannot be written, or no
 * subscriber took it, the dispatch runs directly. A dispatch with no matching hook writes nothing.
 */

interface Run {
	start(): Promise<HookVerdict>;
	settle: { resolve(verdict: HookVerdict): void; reject(error: unknown): void };
	started: boolean;
}

const kindsOf = (session: HookSession, event: HookEvent): string[] => [
	...new Set(session.config[event].flatMap((group) => group.hooks.map((hook) => hook.type ?? "command"))),
];

export function subscribedDispatch(
	api: Pick<FeatureSetup, "settings">,
	session: HookSession,
	direct: Dispatch,
): Dispatch {
	let next = 0;
	const runs = new Map<number, Run>();
	const attached = new WeakMap<EventSubscribers, Set<HookEvent>>();

	const attach = (subscribers: EventSubscribers, event: HookEvent) => {
		const seen = attached.get(subscribers) ?? new Set<HookEvent>();
		attached.set(subscribers, seen);
		if (seen.has(event)) return;
		seen.add(event);
		subscribers.subscribe({
			hook: `run:${event}`,
			topic: hookTopic(event),
			kinds: kindsOf(session, event),
			// Starts the run and returns: the verdict goes to the caller, and a slow hook never holds up the log.
			handle: (stored: AgentEvent) => {
				const token = (stored.payload as { token: number }).token;
				const run = runs.get(token);
				// A run of an earlier process has no caller left to answer.
				if (!run) return;
				run.started = true;
				runs.delete(token);
				run.start().then(run.settle.resolve, run.settle.reject);
			},
		});
	};

	return async (ctx, event, names, input, signal, protocol, hookFilter) => {
		const call = () => direct(ctx, event, names, input, signal, protocol, hookFilter);
		const subscribers = hookSubscribersOf(api, ctx);
		if (!subscribers || commandsFor(session.config, event, names).length === 0) return call();
		attach(subscribers, event);
		const token = ++next;
		const answer = new Promise<HookVerdict>((resolve, reject) => {
			runs.set(token, { start: call, settle: { resolve, reject }, started: false });
		});
		answer.catch(() => undefined);
		try {
			await subscribers.publish({
				topic: hookTopic(event),
				key: `hook:${event}:${token}`,
				at: Date.now(),
				source: makeSource("system", "hooks", "in-process", "proven"),
				payload: { token, names, kinds: kindsOf(session, event) },
				digest: `hook ${event}`,
			});
		} catch (error) {
			recordProblem(`hook:run:${event}`, `the run could not be logged, so it ran directly: ${String(error)}`);
		}
		const run = runs.get(token);
		if (run && !run.started) {
			runs.delete(token);
			return call();
		}
		return answer;
	};
}
