/**
 * The footer status keys (`ui.setStatus`) that Octocode features set and the footer (`ui/footer.ts`) places itself;
 * another feature's key is appended to the footer's second line. The permission mode's key is `PERMISSION_ID`.
 */
export const STATUS = {
	/** Live agents of the team (the agents panel's one-line count). */
	team: "octocode-team",
	/** Typed counts of everything that runs now (`2 agents · 1 bash · 1 wait`); the agents panel (`team/panel.ts`) sets it from `shared/running-work.ts`. */
	running: "octocode-running",
	/** Messages queued behind the running turn. */
	queued: "octocode-queued",
	speed: "octocode-speed",
	backlog: "octocode-backlog",
	/** Completed/total checklist steps belonging to this session, with dropped steps counted separately. */
	steps: "octocode-steps",
	/** A hook command running, with its elapsed time. */
	hooks: "octocode-hooks",
	/** Waiting to try again a turn that a report or message started and a provider error ended. */
	wakeRetry: "octocode-wake-retry",
	/** What this session's timers' judging spent (`timer/register.ts`); the timers themselves are counted in `running`. */
	timers: "octocode-timers",
	/** The active plan's revision (`plan r2`), drawn after the permission chip (`plan/register.ts`). */
	plan: "octocode-plan",
	/** Machine thresholds over their streak now (`swap 92% · load 1.8`), from the monitor (`monitor/register.ts`). */
	monitor: "octocode-monitor",
	/** This main session working with no progress past `monitor.idleAgentMinutes` (`team/session/idle.ts`). */
	idleAgent: "octocode-idle-agent",
} as const;
