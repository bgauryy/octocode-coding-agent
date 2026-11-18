import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Db, MachineProcess, MachineSample } from "../../../../db/src/api.ts";
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
	/** A subagent reads the samples but never takes them, and raises no user notification. */
	isSubagent: boolean;
	/** This session's running background bash jobs. */
	jobs: () => readonly WatchedJob[];
	/** The user's Notification hooks; called only by the session holding the sampler lease, so one alert is one notice. */
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

function alertText(alert: MachineAlert, own: boolean): string {
	return renderPrompt("notices/monitor/alert.md", {
		what: WHAT[alert.rule](alert.value),
		samples: alert.streak,
		threshold: alert.threshold,
		culprits: alert.culprits.map((process) => describeProcess(process, alert.rule)).join(", ") || "unknown",
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
 * The threshold monitor of a session: runs the machine sampler (one process per machine takes the samples), checks each
 * new sample against `monitor.*`, wakes this session when its own processes weigh most in a tripped threshold or one of
 * its background jobs is stuck, and leaves other sessions a note for their next turn and a footer mark.
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
		const rules = new MachineRules(() => settingsOf(api));
		let warned = false;
		const onError = (error: unknown) => {
			if (current !== generation || isStaleSessionError(error)) return;
			// One notice per session: a broken reader would otherwise repeat it every sample.
			if (warned) return;
			warned = true;
			ctx.ui.notify(`The machine monitor stopped reporting: ${errorMessage(error)}`, "warning");
		};
		const ledger = monitorLedgerOf(api);
		/** Sends one alert (a wake when this session owns the cause, else a note) and records it in the ledger once settled. */
		const send = (content: string, attention: Required<Pick<Attention, "at">> & Attention, wake: boolean) => {
			const message = { customType: MONITOR_NOTICE_TYPE, content, display: wake };
			const { rule, value, threshold, at, subject } = attention;
			try {
				const sending = wake
					? wakeGateOf(api).emit(
							{ kind: "monitor.alert", rule, value, threshold, at, ...(subject === undefined ? {} : { subject }) },
							message,
							{ triggerTurn: true, deliverAs: "followUp" },
						)
					: api.session.sendMessage(message, { triggerTurn: false });
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
		const onSample = (sample: MachineSample, holds: boolean) => {
			if (current !== generation) return;
			const { alerts, active } = rules.observe(sample);
			if (ctx.hasUI) ctx.ui.setStatus(STATUS.monitor, statusText(active), "warning");
			for (const rule of MACHINE_RULES)
				ledger.trip(
					machineRuleId(rule),
					active.some((reading) => reading.rule === rule),
				);
			for (const alert of alerts) {
				const own = alert.owner === title();
				const content = alertText(alert, own);
				const { rule, value, threshold, at } = alert;
				send(content, { rule: machineRuleId(rule), value, threshold, at }, own);
				if (holds && !options.isSubagent)
					options.notify?.({ type: "monitor_alert", title: `Octocode: ${WHAT[rule](value)}`, message: content }, ctx);
			}
			const minutes = settingsOf(api).stuckJobMinutes;
			watch.check(options.jobs(), now(), minutes).then((stuck) => {
				if (current !== generation) return;
				for (const job of stuck)
					send(
						stuckJobText(job),
						{ rule: "job", value: Math.round(job.silentMs / 60_000), threshold: minutes, at: now(), subject: job.id },
						true,
					);
			}, onError);
		};
		try {
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
