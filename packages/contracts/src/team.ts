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
	/** The session manager ID of this agent's conversation. The team address can be reused independently of the session ID. */
	sessionId?: string;
	joinedAt: number;
	updatedAt: number;
	toolCalls: number;
	/** Every prompt token it sent (uncached, cache reads and writes); `cacheRead` is the part read from cache. */
	input: number;
	cacheRead: number;
	output: number;
	/** Octocode's estimate at list rates, without the replies of a model with no pricing (`unpriced` says there were some). */
	cost: number;
	unpriced: boolean;
	/** Set by `list`: messages it received that still need an answer. */
	pending?: number;
	/** Set by `list`: paths it has reserved (trees end with `/`). */
	locks?: string[];
}

/** One message as the user sees it in the feed: who talked to whom, and how far it got. */
export interface Traffic {
	id: number;
	from: string;
	to: string[];
	text: string;
	at: number;
	replyTo?: number;
	state: "queued" | "delivered" | "awaiting reply" | "answered" | "dead-lettered";
}
