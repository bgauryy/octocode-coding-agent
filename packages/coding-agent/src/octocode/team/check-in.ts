import { renderInstruction } from "../../core/prompt-template.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { Settings } from "../../core/settings-schema.ts";
import { formatSpan } from "../shared/format.ts";
import type { Mail } from "./mail.ts";
import { PARENT_WAITS_ENV } from "./store/env.ts";
import type { TeamStore } from "./store.ts";

/** What the check-in reads each time, so a settings change applies at the next step. */
export interface CheckInConfig {
	/** Seconds without a message before the ping; 0 is off. */
	seconds: number;
	/** The parent is blocked in this run's `agent` call and reads messages only with its report (a foreground run). */
	parentWaits: boolean;
}

/** The `subagents.checkInSeconds` setting (a value the schema would refuse reads as the default) and how this child runs. */
export function checkInConfig(settings: Settings["subagents"], env: NodeJS.ProcessEnv): CheckInConfig {
	const seconds = settings?.checkInSeconds;
	return {
		seconds:
			typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
				? seconds
				: SETTINGS_DEFAULTS.subagents.checkInSeconds,
		parentWaits: env[PARENT_WAITS_ENV] === "1",
	};
}

/**
 * The periodic ping to a working subagent: a child that has exchanged no message with its parent for the interval is asked,
 * by its own harness, whether it needs something. It runs only between a child's steps (`turn_end` with tool results), when
 * the model is about to be called anyway, so it adds no model request, cannot start a turn in an idle or finished child, and
 * needs no timer. Nothing reaches the parent's process, so it costs the parent nothing. It stops or blocks nothing, and any
 * failure just skips the ping.
 */
export class CheckIn {
	/** When the two last talked, as far as known; undefined until the run's first tick. */
	private talkedAt: number | undefined;
	private readonly mail: Pick<Mail, "notice">;
	constructor(mail: Pick<Mail, "notice">) {
		this.mail = mail;
	}

	/** The run is under way: its start counts as the last talk. */
	begin(now = Date.now()): void {
		this.talkedAt ??= now;
	}

	/** The agent left the team. */
	reset(): void {
		this.talkedAt = undefined;
	}

	/** Between two steps of `me`: sends the ping if it is due. The database is read only once the interval has passed. */
	due(db: TeamStore, me: string, parent: string | undefined, config: CheckInConfig, now = Date.now()): void {
		if (!parent || config.seconds <= 0) return;
		const intervalMs = config.seconds * 1000;
		this.begin(now);
		if (now - this.talkedAt! < intervalMs) return;
		this.talkedAt = Math.max(this.talkedAt!, db.refs.lastExchange(me, parent));
		if (now - this.talkedAt < intervalMs) return;
		const text = renderInstruction("notices/subagents/check-in.md", {
			interval: formatSpan(intervalMs),
			parentWaits: config.parentWaits,
		});
		if (this.mail.notice(text)) this.talkedAt = now;
	}
}
