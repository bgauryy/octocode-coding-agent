import { renderPrompt } from "../../../core/prompt-template.ts";
import { MONITOR_DEFAULTS } from "../../../core/settings-schema/monitor.ts";
import type { Settings } from "../../../core/settings-schema.ts";
import { validSpan } from "./span.ts";

/** How often the idle-agent rule looks: the team ticker beats every second, the rule reads its timestamps once a minute. */
const IDLE_CHECK_MS = 60_000;

/**
 * `monitor.idleAgentMinutes`, else the deprecated `monitor.silenceMinutes`, else the deprecated `subagents.silenceMinutes`,
 * else the default, in milliseconds; 0 is off.
 */
export function idleAgentMs(settings: Pick<Settings, "monitor" | "subagents"> | undefined): number {
	const minutes = [
		settings?.monitor?.idleAgentMinutes,
		settings?.monitor?.silenceMinutes,
		settings?.subagents?.silenceMinutes,
	].find(validSpan);
	return (minutes ?? MONITOR_DEFAULTS.idleAgentMinutes) * 60_000;
}

/** The parent's notice about an idle child; `activity` is the child's last reported activity line. */
export function childIdleText(id: string, minutes: number, activity: string | undefined): string {
	return renderPrompt("notices/monitor/child-silent.md", { id, minutes, activity });
}

/** A main session's note to itself: nobody above it is told. */
export function selfIdleText(minutes: number): string {
	return renderPrompt("notices/monitor/self-idle.md", { minutes });
}

/** One agent's silence: the progress it is about, and whether it was told; new progress starts a new one. */
interface Episode {
	progressAt: number;
	told: boolean;
}

/** An agent the rule watches, with its last progress (undefined: none seen yet, so nothing to measure). */
export interface WatchedAgent {
	id: string;
	progressAt: number | undefined;
}

/**
 * Which working agents made no progress for the threshold: a responsible agent's children, or a main session itself.
 * It compares timestamps the caller already holds, once per `IDLE_CHECK_MS`; the caller decides who is excused (waiting
 * on the user, its children or jobs) and reports each agent it told with `told`. Each silence is told once; an agent's
 * new progress re-arms it.
 */
export class IdleWatch {
	private readonly episodes = new Map<string, Episode>();
	private checkedAt = Number.NEGATIVE_INFINITY;

	/** Whether the minute since the last check has passed; a due check counts as done. */
	due(now: number): boolean {
		if (now - this.checkedAt < IDLE_CHECK_MS) return false;
		this.checkedAt = now;
		return true;
	}

	/** Ids idle for at least `thresholdMs` and not told about this silence; forgets agents no longer listed. */
	idle(agents: readonly WatchedAgent[], thresholdMs: number, now: number): string[] {
		const live = new Set(agents.map((agent) => agent.id));
		for (const id of this.episodes.keys()) if (!live.has(id)) this.episodes.delete(id);
		if (thresholdMs <= 0) return [];
		return agents.flatMap(({ id, progressAt }) => {
			if (progressAt === undefined) return [];
			let episode = this.episodes.get(id);
			if (episode?.progressAt !== progressAt) {
				episode = { progressAt, told: false };
				this.episodes.set(id, episode);
			}
			return !episode.told && now - progressAt >= thresholdMs ? [id] : [];
		});
	}

	/** `id` was told about its current silence. */
	told(id: string): void {
		const episode = this.episodes.get(id);
		if (episode) episode.told = true;
	}

	/** Whether any listed agent is still in a silence it was told about. */
	anyTold(): boolean {
		return [...this.episodes.values()].some((episode) => episode.told);
	}

	reset(): void {
		this.episodes.clear();
		this.checkedAt = Number.NEGATIVE_INFINITY;
	}
}
