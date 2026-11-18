import { machineSamples, withoutWaiting } from "../../../../../db/src/api.ts";
import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { sharedAgentDb } from "../../../storage/database.ts";
import type { AttentionRuleId } from "../../monitor/attention/rules.ts";
import { type Attention, monitorLedgerOf } from "../../monitor/ledger.ts";
import type { MachineRule } from "../../monitor/rules.ts";
import { processStartTime } from "../../shared/process.ts";
import { hookObserver } from "./observe.ts";
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

/**
 * MonitorAlert: observes each alert the monitor ledger records, once, with the rule id as the matcher. The ledger already
 * keeps one alert per trip (cooldowns and hysteresis live in the rules), so this adds no second filter. Machine rules run
 * only in the process that holds the sampler lease; the session rules (jobs, context, idle agents, idle items) belong
 * to this session and always run. The hook runs in the background under the presence deadline and shutdown waits for
 * it; it cannot block or add context.
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
		unsubscribe = monitorLedgerOf(api).subscribe((alert) => observe(alert, ctx));
	});
	api.bus.on("session_shutdown", async () => {
		stop();
		await settled();
	});
}
