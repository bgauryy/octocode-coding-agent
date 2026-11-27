import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import {
	type Db,
	type MachineAlertRow,
	type MachineProcess,
	type MachineSample,
	machineSamples,
	withoutWaiting,
} from "../../../../db/src/api.ts";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { MONITOR_DEFAULTS } from "../../core/settings-schema/monitor.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { processStartTime } from "../shared/process.ts";
import { STATUS } from "../shared/status.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { wakeGateOf } from "../wake/gate.ts";
import { machineRuleId } from "./attention/rules.ts";
import { type Attention, monitorLedgerOf } from "./ledger.ts";
import { type MachineAlert, MachineRules, type MachineRule, type Reading } from "./rules.ts";
import { type MachineSampler, startMachineSampler } from "./sampler.ts";
import { type StuckJob, StuckJobWatch, type WatchedJob } from "./stuck-jobs.ts";

/** The custom message type of monitor notices. */
const MONITOR_NOTICE_TYPE = "octocode-monitor";

type MonitorSettings = {
	-readonly [K in keyof typeof MONITOR_DEFAULTS]: (typeof MONITOR_DEFAULTS)[K] extends boolean
		? boolean
		: (typeof MONITOR_DEFAULTS)[K] extends readonly number[]
			? readonly number[]
			: number;
};

export interface MonitorOptions {
	/**
	 * A subagent neither samples nor runs `MachineRules`, and raises no user notification: it hears only the alerts whose
	 * culprit it owns.
	 */
	isSubagent: boolean;
	/** This session's running background bash jobs. */
	jobs: () => readonly WatchedJob[];
	/** The user's Notification hooks; called only by the publisher (the session holding the sampler lease), so one alert is one notice. */
	notify?: (notice: { type: string; title: string; message: string }, ctx: FeatureContext) => void;
	// Boundaries a test replaces.
	db?: () => Db;
	start?: typeof startMachineSampler;
	watch?: StuckJobWatch;
	title?: () => string;
	now?: () => number;
}

const WHAT: Record<MachineRule, (value: number) => string> = {
	load: (value) => `Load ${value} per CPU`,
	memory: (value) => `Memory available ${value}%`,
	swap: (value) => `Swap ${value}% used`,
	gpu: (value) => `GPU ${value}% busy`,
};

const MACHINE_RULES = Object.keys(WHAT) as MachineRule[];

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

function describeProcess(process: MachineProcess, rule: MachineRule): string {
	const figure = rule === "memory" || rule === "swap" ? gib(process.rss) : `${Math.round(process.cpu)}% CPU`;
	return `${process.command} ${figure}${process.owner ? ` (${process.owner})` : ""}`;
}

function alertText(alert: Omit<MachineAlert, "rule"> & { rule: string }, own: boolean): string {
	return renderPrompt("notices/monitor/alert.md", {
		what: WHAT[alert.rule as MachineRule](alert.value),
		samples: alert.streak,
		threshold: alert.threshold,
		culprits:
			alert.culprits.map((process) => describeProcess(process, alert.rule as MachineRule)).join(", ") || "unknown",
		own,
		owner: alert.owner ?? "",
	}).trim();
}

function stuckJobText(job: StuckJob): string {
	return renderPrompt("notices/monitor/stuck-job.md", {
		job: job.id,
		cpu: Math.round(job.cpu * 10) / 10,
		minutes: Math.round(job.silentMs / 60_000),
		command: job.command.split("\n")[0].slice(0, 120),
		log: job.log,
	}).trim();
}

/** The footer mark: every threshold over its streak now, e.g. `swap 92% · load 1.8`. */
export function statusText(active: readonly Reading[]): string | undefined {
	if (active.length === 0) return undefined;
	return active.map(({ rule, value }) => (rule === "load" ? `load ${value}` : `${rule} ${value}%`)).join(" · ");
}

function settingsOf(api: FeatureSetup): MonitorSettings {
	return { ...MONITOR_DEFAULTS, ...api.settings.get().monitor };
}

/**
 * The threshold monitor of a session. One process per machine publishes the machine's alerts: the sampler lease holder
 * checks each new sample against `monitor.*` and files each tripped threshold once in the database. Every session reads
 * the alerts filed after it started: the session that owns the cause is woken, a root session gets a note for its next turn
 * and a footer mark, and a subagent gets nothing unless it owns the cause (it never runs `MachineRules`). A stuck
 * background job wakes its own session.
 */
export function registerMonitor(api: FeatureSetup, options: MonitorOptions): void {
	const db = options.db ?? (() => sharedAgentDb().db);
	const start = options.start ?? startMachineSampler;
	const watch = options.watch ?? new StuckJobWatch();
	const title = options.title ?? (() => process.title);
	const now = options.now ?? Date.now;
	let sampler: MachineSampler | undefined;
	let generation = 0;

	const stop = () => {
		generation++;
		sampler?.stop();
		sampler = undefined;
	};

	api.bus.on("session_start", (_event, ctx) => {
		stop();
		const initial = settingsOf(api);
		if (!initial.enabled) return;
		const current = generation;
		// The footer mark and the ledger of a root session follow the thresholds; only the lease holder's alerts are published.
		const rules = options.isSubagent ? undefined : new MachineRules(() => settingsOf(api));
		let cursor = 0;
		let warned = false;
		const onError = (error: unknown) => {
			if (current !== generation || isStaleSessionError(error)) return;
			// One notice per session: a broken reader would otherwise repeat it every sample.
			if (warned) return;
			warned = true;
			try {
				ctx.ui.notify(`The machine monitor stopped reporting: ${errorMessage(error)}`, "warning");
			} catch (notifyError) {
				// The session was replaced before its shutdown reached this monitor: there is no screen left to tell.
				if (!isStaleSessionError(notifyError)) throw notifyError;
			}
		};
		const ledger = monitorLedgerOf(api);
		/** Wakes this session with one alert whose cause it owns and records it in the ledger once settled. */
		const send = (content: string, attention: Required<Pick<Attention, "at">> & Attention) => {
			const message = { customType: MONITOR_NOTICE_TYPE, content, display: true };
			const { rule, value, threshold, at, subject } = attention;
			try {
				const sending = wakeGateOf(api).emit(
					{ kind: "monitor.alert", rule, value, threshold, at, ...(subject === undefined ? {} : { subject }) },
					message,
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				Promise.resolve(sending).then(
					() => ledger.record(attention, true),
					(error: unknown) => {
						ledger.record(attention, false);
						onError(error);
					},
				);
			} catch (error) {
				ledger.record(attention, false);
				onError(error);
			}
		};
		/** Files what the rules decided on this sample: the one place a machine alert is made. */
		const publish = (alerts: readonly MachineAlert[]) => {
			for (const alert of alerts) {
				machineSamples.recordAlert(db(), alert);
				const { rule, value } = alert;
				options.notify?.(
					{
						type: "monitor_alert",
						title: `Octocode: ${WHAT[rule](value)}`,
						message: alertText(alert, alert.owner === title()),
					},
					ctx,
				);
			}
		};
		/**
		 * Delivers what the publisher filed since the last read: a wake to the session whose processes cause it; another root
		 * session only records it in the ledger (its footer mark comes from the rules), as the model can do nothing about
		 * load it does not own; a subagent that does not own it, nothing.
		 */
		const deliver = (rows: readonly MachineAlertRow[]) => {
			for (const row of rows) {
				cursor = row.seq;
				const own = row.owner === title();
				if (!own && options.isSubagent) continue;
				const rule = row.rule as MachineRule;
				const attention = { rule: machineRuleId(rule), value: row.value, threshold: row.threshold, at: row.at };
				if (own) send(alertText(row, own), attention);
				else ledger.record(attention, true);
			}
		};
		const onSample = (sample: MachineSample, holds: boolean) => {
			if (current !== generation) return;
			const observed = rules?.observe(sample);
			if (observed) {
				const { active } = observed;
				if (ctx.hasUI) ctx.ui.setStatus(STATUS.monitor, statusText(active), "warning");
				for (const rule of MACHINE_RULES)
					ledger.trip(
						machineRuleId(rule),
						active.some((reading) => reading.rule === rule),
					);
			}
			if (holds && observed) publish(observed.alerts);
			deliver(withoutWaiting(db(), () => machineSamples.alertsAfter(db(), cursor)));
			const minutes = settingsOf(api).stuckJobMinutes;
			watch.check(options.jobs(), now(), minutes).then((stuck) => {
				if (current !== generation) return;
				for (const job of stuck)
					send(stuckJobText(job), {
						rule: "job",
						value: Math.round(job.silentMs / 60_000),
						threshold: minutes,
						at: now(),
						subject: job.id,
					});
			}, onError);
		};
		try {
			cursor = withoutWaiting(db(), () => machineSamples.lastAlertSeq(db()));
			sampler = start({
				db: db(),
				holder: `${process.pid}:${processStartTime(process.pid) ?? ""}`,
				intervalMs: initial.sampleSeconds * 1000,
				takesSamples: !options.isSubagent,
				onSample,
				onError,
			});
		} catch (error) {
			onError(error);
		}
	});

	api.bus.on("session_shutdown", stop);
}
