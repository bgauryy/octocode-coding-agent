import { randomUUID } from "node:crypto";
import type { FeatureContext } from "../../../core/features/index.ts";
import { recordProblem } from "../../../core/diagnostics-log.ts";
import { hookTopic } from "../../events/hook-lifecycle.ts";
import { makeSource } from "../../events/source.ts";
import type { EventSubscribers } from "../../events/subscribers.ts";
import type { HookEvent } from "../catalog.ts";
import { commandsFor } from "../config/calls.ts";
import type { HookHandler, HookVerdict } from "../contracts.ts";
import { hookSubscribersOf } from "./subscribers.ts";
import type { Dispatch, HookSession } from "./types.ts";

/**
 * A dispatch that has a matching hook
 * writes a `hook.<Event>` event and the runner starts from the session's `hook:run:<Event>` subscription, whose row names the
 * handler kinds configured for the event. The caller still awaits the very verdict the runner returns, so a deny, a rewrite
 * or a context reaches the tool call, the prompt or the stop exactly as before; the subscription replaces the call, not the
 * answer. Nothing that cannot be started from the subscription is ever dropped: when the event cannot be written, or no
 * subscriber took it, the dispatch runs directly. A dispatch with no matching hook writes nothing.
 */

interface Run {
	start(): Promise<HookVerdict>;
	settle: { resolve(verdict: HookVerdict): void; reject(error: unknown): void };
}

const kindsOf = (session: HookSession, event: HookEvent): string[] => [
	...new Set(session.config[event].flatMap((group) => group.hooks.map((hook) => hook.type ?? "command"))),
];

export type MatchedHookRun = (
	ctx: FeatureContext,
	event: HookEvent,
	input: Parameters<Dispatch>[3],
	signal: AbortSignal | undefined,
	protocol: Parameters<Dispatch>[5],
	hooks: HookHandler[],
) => Promise<HookVerdict>;

export function subscribedDispatch(api: object, session: HookSession, direct: MatchedHookRun): Dispatch {
	let next = 0;
	const owner = randomUUID();
	const runs = new Map<string, Run>();
	const attached = new WeakMap<EventSubscribers, Map<HookEvent, Promise<() => void>>>();

	const attach = (subscribers: EventSubscribers, event: HookEvent) => {
		const seen = attached.get(subscribers) ?? new Map<HookEvent, Promise<() => void>>();
		attached.set(subscribers, seen);
		const existing = seen.get(event);
		if (existing) return existing;
		const registration = subscribers
			.subscribe({
				hook: `run:${event}`,
				topic: hookTopic(event),
				kinds: kindsOf(session, event),
				// Starts the run and returns: the verdict goes to the caller, and a slow hook never holds up the log.
				handle: (stored) => {
					const run = runs.get(stored.key);
					// A run of an earlier process has no caller left to answer.
					if (!run) return;
					runs.delete(stored.key);
					run.start().then(run.settle.resolve, run.settle.reject);
				},
			})
			.catch((error: unknown) => {
				seen.delete(event);
				throw error;
			});
		seen.set(event, registration);
		return registration;
	};

	return async (ctx, event, names, input, signal, protocol, hookFilter) => {
		const hooks = commandsFor(session.config, event, names).filter((hook) => {
			const profile = hook.protocol ?? "octocode";
			return (
				(!protocol || (typeof protocol === "string" ? protocol === profile : protocol.includes(profile))) &&
				(!hookFilter || hookFilter(hook))
			);
		});
		if (hooks.length === 0) return {};
		const call = () => direct(ctx, event, input, signal, protocol, hooks);
		let subscribers: EventSubscribers;
		try {
			subscribers = await hookSubscribersOf(api, ctx);
			await attach(subscribers, event);
		} catch (error) {
			recordProblem(`hook:run:${event}`, `the run could not be subscribed, so it ran directly: ${String(error)}`);
			return call();
		}
		const token = ++next;
		const key = `hook:${event}:${owner}:${token}`;
		const answer = new Promise<HookVerdict>((resolve, reject) => {
			runs.set(key, { start: call, settle: { resolve, reject } });
		});
		answer.catch(() => undefined);
		try {
			await subscribers.publish({
				topic: hookTopic(event),
				key,
				at: Date.now(),
				source: makeSource("system", "hooks", "in-process", "proven"),
				payload: { token, names, kinds: [...new Set(hooks.map((hook) => hook.type ?? "command"))] },
				digest: `hook ${event}`,
			});
		} catch (error) {
			recordProblem(`hook:run:${event}`, `the run could not be logged, so it ran directly: ${String(error)}`);
		}
		if (runs.delete(key)) return call();
		return answer;
	};
}
