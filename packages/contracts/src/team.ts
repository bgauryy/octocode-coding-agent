export interface Member {
	/** Unique across the shared database, and the address used by sendMessage: a name from `names.ts` (`inky-kraken`). */
	id: string;
	/** `main` for a session, the profile name (or `general`) for a subagent: what it is, where `id` says who. */
	role: string;
	parentId?: string;
	pid: number;
	/** When the process `pid` names started (`processStartTime`), absent where unknown: with the pid it names one process, which a later one that got the pid is not. */
	started?: string;
	/** `settled`: a headless child whose run ended while its parent still holds its reservations; never listed as a live teammate and unreachable by mail. */
	status: "idle" | "working" | "settled";
	/** Explicit cooperative runner mailbox; absent for native push delivery. */
	mailbox?: "pull";
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
	/** Set when the sender asked for an answer (a request). */
	replyRequired?: true;
	/** When the first recipient took it (epoch ms); absent while every delivery is still queued. */
	deliveredAt?: number;
	state: TrafficState;
	/** The recipients that left the team without reading it (`read` false) or, for a question, without answering it; absent when none did. */
	dropped?: TrafficDrop[];
	/** Each recipient's own delivery state; absent in older snapshots. */
	deliveries?: TrafficDelivery[];
	/** Who sent it and who received it, resolved when it is read (`team/endpoint.ts`); absent where no resolver ran. */
	fromEndpoint?: Endpoint;
	toEndpoints?: Endpoint[];
}

/** How far a message (or one recipient's copy of it) got. */
export type TrafficState = "queued" | "delivered" | "awaiting reply" | "answered" | "dead-lettered";

/** One recipient's copy of a message: `read` is set on a dead letter and says whether the recipient read it before leaving. */
export interface TrafficDelivery {
	recipient: string;
	state: TrafficState;
	deliveredAt?: number;
	read?: boolean;
}

/**
 * One end of a message: who it is and where it runs. `worktree` is `main` for the viewer's checkout, else `worktree <name>`
 * (with ` (gone)` when its folder was removed). A sender that is not an agent (`user`, `team`, `external`) has that name as
 * its role. `departed` marks an agent that left the team: the facts are its last recorded row.
 */
export interface Endpoint {
	id: string;
	role?: string;
	sessionId?: string;
	parentId?: string;
	worktree?: string;
	branch?: string;
	tmuxPane?: string;
	departed?: true;
}

/** Where an agent's own transcript holds what it did near a point in time; the entry is a line index of its session file. */
export interface TranscriptRef {
	agentId: string;
	sessionId?: string;
	entry: number;
}

/**
 * One row of the agents' message feed, a team message or an internal notice (`internal`: a check-in, lease or dead-letter
 * notice, or mail from a local API client; these are never stored as team messages). `key` is stable and orders the feed.
 */
export interface FeedEntry {
	key: string;
	/** The team message id; absent on a notice. */
	id?: number;
	at: number;
	internal?: true;
	/** A notice's custom message type. */
	label?: string;
	from: Endpoint;
	to: Endpoint[];
	text: string;
	replyTo?: number;
	replyRequired?: true;
	state?: TrafficState;
	deliveredAt?: number;
	deliveries?: TrafficDelivery[];
	dropped?: TrafficDrop[];
	/** The sender's transcript entry nearest the send (a notice: the receiver's entry that holds it), for its thinking and output. */
	transcript?: TranscriptRef;
}

/** Where the next page of the feed starts: entries older than this point. */
export interface FeedCursor {
	at: number;
	key: string;
}

/** One page of the feed, newest first; `next` is set while older entries remain. */
export interface FeedPage {
	entries: FeedEntry[];
	next?: FeedCursor;
}

/** One recipient that dropped a message (`Traffic.dropped`). */
export interface TrafficDrop {
	recipient: string;
	read: boolean;
}

/** The custom message type that carries delivered agent mail; its `details.messages` is the batch. */
export const MAIL_MESSAGE_TYPE = "octocode-agent-message";

/** Who is working, as every surface marks it: the main agent (a session a person drives) as a squid, a subagent as an octopus. */
export const ENTITY = { main: "🦑", subagent: "🐙" } as const;

/** Process roles that run a main session: the terminal app, an RPC host and an ACP host. Every other role is a subagent's. */
const MAIN_ROLES: ReadonlySet<string> = new Set(["main", "rpc", "acp"]);

/** The mark of a process role (`main`, `rpc`, `acp`, or a subagent's role such as `researcher`). */
export const entityOfRole = (role: string): string => (MAIN_ROLES.has(role) ? ENTITY.main : ENTITY.subagent);

/** The kind words of a message: a reply names what it answers (`reply` alone when the recipient already does). */
export function mailKinds(
	message: { replyRequired?: unknown; replyTo?: unknown; interrupt?: unknown },
	replyLinked = true,
): string[] {
	const words = [
		message.replyTo === undefined
			? ""
			: replyLinked
				? `reply to #${typeof message.replyTo === "string" || typeof message.replyTo === "number" ? message.replyTo : ""}`
				: "reply",
		message.replyRequired === true ? "request" : "",
		message.interrupt === true ? "interrupt" : "",
	].filter(Boolean);
	return words.length ? words : ["FYI"];
}

/** One delivered message as a view draws it: header facts and the body. */
export interface MailView {
	from: string;
	to?: string;
	/** The sender's role when its message recorded one, for the entity mark. */
	role?: string;
	number?: number;
	kinds: string[];
	forwardedBy?: string;
	at?: number;
	text: string;
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

/** The messages of a delivered-mail custom message's `details`; anything but a batch is undefined (the model's text shows). */
export function mailViews(details: unknown): MailView[] | undefined {
	const batch = (details as { messages?: unknown } | null | undefined)?.messages;
	if (!Array.isArray(batch) || batch.length === 0) return undefined;
	return batch.map((raw: unknown) => {
		const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		const role = (entry.sender as { role?: unknown } | undefined)?.role;
		const by = str(entry.forwardedBy);
		const note = by && entry.note !== undefined ? `${by}: ${str(entry.note) ?? ""}\n` : "";
		return {
			from: str(entry.from)?.slice(0, 64) || "agent",
			...(str(entry.to) ? { to: str(entry.to)?.slice(0, 64) } : {}),
			...(typeof role === "string" && entry.from !== "user" ? { role } : {}),
			...(typeof entry.id === "number" ? { number: entry.id } : {}),
			kinds: mailKinds(entry),
			...(by ? { forwardedBy: by.slice(0, 64) } : {}),
			...(typeof entry.at === "number" ? { at: entry.at } : {}),
			text: `${note}${str(entry.text) ?? ""}`,
		};
	});
}
