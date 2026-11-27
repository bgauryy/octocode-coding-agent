import { renderPrompt } from "../../../core/prompt-template.ts";
import { MONITOR_DEFAULTS } from "../../../core/settings-schema/monitor.ts";
import type { Settings } from "../../../core/settings-schema.ts";
import { formatSpan } from "../../shared/format.ts";
import { runningWorkOf } from "../../shared/running-work.ts";
import type { Attention } from "../ledger.ts";
import { validSpan } from "./span.ts";

/** What the check-in reads each time, so a settings change applies at the next step. */
export interface CheckInConfig {
	/** Seconds without a message before the ping; 0 is off. */
	seconds: number;
	/** The parent is blocked in this run's `agent` call and reads messages only with its report (a foreground run). */
	parentWaits: boolean;
	/** This child has a pending timer or a running background bash job of its own: it waits legitimately, so no ping. */
	busy?: boolean;
}

/** What the check-in needs of its owner: when the two last talked, and the notice that joins the child's next step. */
export interface CheckInHost {
	/** When `me` and `parent` last exchanged a message (epoch ms; 0 when never). */
	lastExchange(me: string, parent: string): number;
	/** Sends the ping; false when the session cannot take it now. */
	notice(text: string): boolean;
	/** Each ping attempted, with whether it was taken (the monitor ledger). */
	record?(attention: Attention, delivered: boolean): void;
}

/** `monitor.checkInSeconds`, else the default; a refused value is unset. */
export function checkInSeconds(settings: Pick<Settings, "monitor"> | undefined): number {
	const current = settings?.monitor?.checkInSeconds;
	return validSpan(current) ? current : MONITOR_DEFAULTS.checkInSeconds;
}

/** Whether the session of `owner` (its feature API) lists a background bash job or a timer: the two things that wake a child that ended its turn. */
const waitsOnWork = (owner: object): boolean =>
	runningWorkOf(owner)
		.all()
		.some((row) => row.kind === "bash" || row.kind === "timer");

/** The check-in setting and how this child runs: `parentWaits` from its owner, `busy` from `owner`'s running work. */
export function checkInConfig(
	settings: Pick<Settings, "monitor"> | undefined,
	parentWaits: boolean,
	owner?: object,
): CheckInConfig {
	return { seconds: checkInSeconds(settings), parentWaits, busy: owner ? waitsOnWork(owner) : false };
}

/**
 * The periodic ping to a working subagent: a child that has exchanged no message with its parent for the interval is asked,
 * by its own harness, whether it needs something. It runs only between a child's steps (`turn_end` with tool results), when
 * the model is about to be called anyway, so it adds no model request, cannot start a turn in an idle or finished child, and
 * needs no timer. Nothing reaches the parent's process, so it costs the parent nothing. It stops or blocks nothing.
 */
export class CheckIn {
	/** When the two last talked, as far as known; undefined until the run's first tick. */
	private talkedAt: number | undefined;
	private readonly host: CheckInHost;
	constructor(host: CheckInHost) {
		this.host = host;
	}

	/** The run is under way: its start counts as the last talk. */
	begin(now = Date.now()): void {
		this.talkedAt ??= now;
	}

	/** The agent left the team. */
	reset(): void {
		this.talkedAt = undefined;
	}

	/** Between two steps of `me`: sends the ping if it is due. The exchange log is read only once the interval has passed. */
	due(me: string, parent: string | undefined, config: CheckInConfig, now = Date.now()): void {
		if (!parent || config.seconds <= 0 || config.busy) return;
		const intervalMs = config.seconds * 1000;
		this.begin(now);
		if (now - this.talkedAt! < intervalMs) return;
		this.talkedAt = Math.max(this.talkedAt!, this.host.lastExchange(me, parent));
		if (now - this.talkedAt < intervalMs) return;
		const text = renderPrompt("notices/monitor/check-in.md", {
			interval: formatSpan(intervalMs),
			parentWaits: config.parentWaits,
		});
		const attention: Attention = {
			rule: "check-in",
			value: Math.round((now - this.talkedAt) / 1000),
			threshold: config.seconds,
			subject: parent,
			at: now,
		};
		const delivered = this.host.notice(text);
		this.host.record?.(attention, delivered);
		if (delivered) this.talkedAt = now;
	}
}
