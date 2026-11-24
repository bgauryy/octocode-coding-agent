import { machineSamples, withoutWaiting } from "../../../../../db/src/api.ts";
import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { sharedAgentDb } from "../../../storage/database.ts";
import type { AttentionRuleId } from "../../monitor/attention/rules.ts";
import { type Attention, monitorLedgerOf } from "../../monitor/ledger.ts";
import type { MachineRule } from "../../monitor/rules.ts";
import { processStartTime } from "../../shared/process.ts";
import { MONITOR_SOURCE } from "../../events/source.ts";
import type { AgentEvent } from "../../events/topics.ts";
import { describeEvent } from "../../wake/catalog.ts";
import { recordProblem } from "../../../core/diagnostics-log.ts";
import { hookObserver } from "./observe.ts";
import { closeHookSubscribers, hookSubscribersOf } from "./subscribers.ts";
import type { Dispatch, HookSession, ReportFailure } from "./types.ts";

const EVENT = "MonitorAlert";

/**
 * The rules about the machine, not about this session. Every session reads the same samples and records the same alert
 * in its own ledger, so only the process holding the sampler lease runs the user's hook for one.
 */
const MACHINE_RULES: Record<MachineRule, true> = { load: true, memory: true, swap: true, gpu: true };
const isMachineRule = (rule: AttentionRuleId): rule is MachineRule => Object.hasOwn(MACHINE_RULES, rule);

export interface MonitorHookOptions {
	/** Whether this process holds the machine sampler lease now; the sampler's own check by default. */
	holdsSampler?: () => boolean;
	now?: () => number;
}

/** The lease holder name the machine sampler uses (`monitor/register.ts`): this process's pid and start time. */
const samplerHolder = () => `${process.pid}:${processStartTime(process.pid) ?? ""}`;

const holdsLease = (): boolean => {
	const { db } = sharedAgentDb();
	return withoutWaiting(db, () => machineSamples.holderAt(db, Date.now()))?.holder === samplerHolder();
};

/** The input of a MonitorAlert hook (the dispatcher adds `hook_event_name`, `session_id` and `cwd`). */
function alertHookInput(alert: Attention & { delivered: boolean }, now: () => number): Record<string, unknown> {
	return {
		rule: alert.rule,
		value: alert.value,
		threshold: alert.threshold,
		subject: alert.subject ?? null,
		at: alert.at ?? now(),
		delivered: alert.delivered,
	};
}

/** The alert as a `monitor.alert` event for the log; whether it reached the session rides in the replay body. */
function alertEvent(alert: Attention & { delivered: boolean }, now: () => number): Omit<AgentEvent, "seq"> {
	const at = alert.at ?? now();
	const payload = {
		kind: "monitor.alert" as const,
		rule: alert.rule,
		value: alert.value,
		threshold: alert.threshold,
		at,
		...(alert.subject === undefined ? {} : { subject: alert.subject }),
	};
	const { label, key } = describeEvent(payload);
	const { kind: _kind, ...fields } = payload;
	return {
		topic: "monitor.alert",
		key,
		at,
		source: MONITOR_SOURCE,
		payload: fields,
		digest: label,
		body: { delivered: alert.delivered },
	};
}

/** The alert a stored `monitor.alert` event holds. */
function alertOf(event: AgentEvent): Attention & { delivered: boolean } {
	const payload = event.payload as AgentEvent<"monitor.alert">["payload"];
	return {
		rule: payload.rule as AttentionRuleId,
		value: payload.value,
		threshold: payload.threshold,
		at: payload.at,
		...(payload.subject === undefined ? {} : { subject: payload.subject }),
		delivered: event.body?.delivered === true,
	};
}

/**
 * MonitorAlert: observes each alert the monitor ledger records, once, with the rule id as the matcher. The ledger already
 * keeps one alert per trip (cooldowns and hysteresis live in the rules), so this adds no second filter. Machine rules run
 * only in the process that holds the sampler lease; the session rules (jobs, context, idle agents, idle items) belong
 * to this session and always run. The hook runs in the background under the presence deadline and shutdown waits for
 * it; it cannot block or add context.
 *
 * The ledger writes each alert to the event log and the hook hears it as a subscriber of
 * `monitor.alert` (`events/subscribers.ts`): once, with its offset kept across a restart.
 */
export function registerMonitorHooks(
	api: FeatureSetup,
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
	options: MonitorHookOptions = {},
): void {
	const holdsSampler = options.holdsSampler ?? holdsLease;
	const now = options.now ?? Date.now;
	let unsubscribe: (() => void) | undefined;
	const { observe: run, settled } = hookObserver(session, { dispatch, reportFailure }, { defer: true });

	const observe = (alert: Attention & { delivered: boolean }, ctx: FeatureContext) =>
		run(
			EVENT,
			alert.rule,
			() => alertHookInput(alert, now),
			ctx,
			() => isMachineRule(alert.rule) && !holdsSampler(),
		);

	const stop = () => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
	api.bus.on("session_start", async (_event, ctx) => {
		stop();
		// A session whose store cannot name it has no durable lane: its alerts are observed live, and the reason is logged.
		let subscribers: Awaited<ReturnType<typeof hookSubscribersOf>>;
		let unhear: () => void;
		const fail = (error: unknown) => void recordProblem("hook:monitor-alert", error);
		try {
			subscribers = await hookSubscribersOf(api, ctx);
			unhear = await subscribers.subscribe({
				hook: "monitor-alert",
				topic: "monitor.alert",
				handle: (event) => observe(alertOf(event), ctx),
			});
		} catch (error) {
			fail(error);
			unsubscribe = monitorLedgerOf(api).subscribe((alert) => observe(alert, ctx));
			return;
		}
		const unpublish = monitorLedgerOf(api).subscribe((alert) => {
			subscribers.publish(alertEvent(alert, now)).catch(fail);
		});
		unsubscribe = () => {
			unpublish();
			unhear();
		};
		// What an earlier run published and did not handle is handled now, once.
		subscribers.pump().catch(fail);
	});
	api.bus.on("session_shutdown", async () => {
		stop();
		await closeHookSubscribers(api);
		await settled();
	});
}
