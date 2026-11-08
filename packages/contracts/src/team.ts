export interface Member {
	/** Unique across the shared database, and the address used by sendMessage: a name from `names.ts` (`inky-kraken`). */
	id: string;
	/** `main` for a session, the profile name (or `general`) for a subagent: what it is, where `id` says who. */
	role: string;
	parentId?: string;
	pid: number;
	/** When the process `pid` names started (`processStartTime`), absent where unknown: with the pid it names one process, which a later one that got the pid is not. */
	started?: string;
	status: "idle" | "working";
	/** What it works on, any length (`checkGoal` in `identity.ts` refuses only a missing one). Stored in the `task` column. */
	goal?: string;
	/** The tool it is running right now. */
	activity?: string;
	/** The model it runs (`claude-opus-4-5`), as Octocode names it; absent until known. */
	model?: string;
	/** The worktree root it works in (absolute), where its `locks` are relative to; absent in rows older builds wrote. Worktrees of one repository share a team, so it can differ from the caller's. */
	checkout?: string;
	/** The tmux pane a main session runs in (`%12`, from `TMUX_PANE`); absent outside tmux, for subagents and in rows older builds wrote. */
	tmuxPane?: string;
	/** Where the agent works: its folder, git branch and process title, recorded when it joined (shown by `coordinate list`). */
	cwd?: string;
	branch?: string;
	processTitle?: string;
	/**
	 * Derived, never stored: the folder of the worktree it works in when that is not its viewer's checkout (a linked worktree,
	 * or an isolated child's private one, whose `checkout` stays its coordinator's). Absent in the main checkout and in older snapshots.
	 */
	worktree?: string;
	/** The session manager ID of this agent's conversation. The team address can be reused independently of the session ID. */
	sessionId?: string;
	joinedAt: number;
	updatedAt: number;
	toolCalls: number;
	/** Every prompt token it sent (uncached, cache reads and writes); `cacheRead` is the part read from cache. */
	input: number;
	cacheRead: number;
	/** The part of `input` the provider wrote to cache on this agent's replies. */
	/** Absent on rows written before cache writes were counted; read as 0. */
	cacheWrite?: number;
	output: number;
	/** Octocode's estimate at list rates, without the replies of a model with no pricing (`unpriced` says there were some). */
	cost: number;
	unpriced: boolean;
	/** Set by `list`: messages it received that still need an answer. */
	pending?: number;
	/** Set by `list`: paths it has reserved (trees end with `/`). */
	locks?: string[];
	/** Set by the process running this subagent, in what it lists: when the subagent last wrote output. */
	lastOutputAt?: number;
	/**
	 * Set by the host that shows the user's dialogs: the member is blocked on the user (`approval`: a permission dialog;
	 * `reply`: a question that waits for an answer). Absent for a member that does not wait; older snapshots omit it.
	 */
	waiting?: "approval" | "reply";
	/** Set by the host that ran the subagent once its run ended: how it ended. Absent while it runs and in older snapshots. */
	outcome?: "done" | "partial" | "blocked" | "failed" | "stopped";
	/** One line on how the run ended (`outcome`). */
	headline?: string;
}

/** One message as the user sees it in the feed: who talked to whom, and how far it got. */
export interface Traffic {
	id: number;
	from: string;
	to: string[];
	text: string;
	at: number;
	replyTo?: number;
	/** When the first recipient took it (epoch ms); absent while every delivery is still queued. */
	deliveredAt?: number;
	state: "queued" | "delivered" | "awaiting reply" | "answered" | "dead-lettered";
}
