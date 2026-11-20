import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { type AgentDb, backlog as backlogQueries } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { clip } from "../shared/text.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { taskLine } from "./task-source.ts";

/** The customType of the hidden message that carries foreign backlog changes and the task line. */
export const BACKLOG_EVENTS_TYPE = "backlog-events";

/** Audit rows read per query; a longer gap is read in pages. */
const PAGE = 200;
/** Foreign changes the task line names; the rest are counted. */
const MAX_CHANGED = 5;
const TITLE_CHARS = 48;
const eventsNotice = (events: string) => renderPrompt("notices/backlog-events.md", { events, resync: false });
const RESYNC_NOTICE = () => renderPrompt("notices/backlog-events.md", { events: "", resync: true });

type AuditRow = Extract<ReturnType<typeof backlogQueries.auditAfter>, { resync: false }>["rows"][number];

/** One held item's foreign changes, collapsed: the newest row, whether this agent's holder held it before, and who wrote last. */
interface Change {
	row: AuditRow;
	heldBefore: boolean;
	by: string;
}

const actorId = (json: string): string | undefined => {
	try {
		return (JSON.parse(json) as { id?: string }).id;
	} catch {
		return undefined;
	}
};

/** What this agent holds: a subagent its delegated item, a main session the items assigned to it (a subagent's parent's). */
const holders = (b: Backlog): ReadonlySet<string> => b.actor.owners ?? new Set([b.session]);

/**
 * Follows the backlog change log for one agent from the cursor of its last snapshot. Rows this agent wrote (its actor id,
 * on any surface: tool, web or command) are dropped; the rest name the items changed elsewhere, and those on a held item
 * become events, collapsed to the newest row per item. A held item closed, finished, released or reassigned elsewhere
 * is urgent: sent right after the current tool result. The rest wait for the next user turn, with the task line when it
 * changed.
 */
class TaskEvents {
	private cursor: number | undefined;
	private resync = false;
	private readonly pending = new Map<string, Change>();
	private readonly changed = new Set<string>();
	private lastLine: string | undefined;
	private lastStamp: string | undefined;
	/**
	 * The board last opened, while what chose it is unchanged: opening registers the workspace (a git probe and a write)
	 * and ran after every tool result. Changes on the board are still found by `store.revision`.
	 */
	private opened: { key: string; agent: AgentDb; backlog: Backlog } | undefined;

	private readonly api: FeatureSetup;
	private readonly options: BacklogOptions;

	constructor(api: FeatureSetup, options: BacklogOptions) {
		this.api = api;
		this.options = options;
	}

	private db() {
		return sharedAgentDb(this.options.env ?? process.env).db;
	}

	/** A new span: the snapshot's cursor and task line become the baseline; nothing before them is reported. */
	start(ctx: FeatureContext): void {
		this.cursor = undefined;
		this.resync = false;
		this.pending.clear();
		this.changed.clear();
		this.lastLine = undefined;
		this.opened = undefined;
		const b = this.open(ctx);
		if (!b) return;
		this.lastStamp = b.store.revision;
		const snap = backlogQueries.snapshot(this.db(), b.store.repo);
		this.cursor = snap.cursor;
		this.lastLine = taskLine(snap, b.session, [], b.actor.item);
	}

	/** After a tool result (or a database change during a run): sends the urgent events, once. Settles once they are sent. */
	async urgent(ctx: FeatureContext): Promise<void> {
		const b = this.read(ctx);
		if (!b) return;
		const urgent = [...this.pending].filter(([, change]) => isUrgent(change, b));
		if (urgent.length === 0) return;
		for (const [ref] of urgent) this.pending.delete(ref);
		const content = eventsNotice(urgent.map(([ref, change]) => describe(ref, change, b)).join("; "));
		// Steered into the run (or appended when idle): it starts no turn, so it settles at once.
		await this.api.session.sendMessage(
			{ customType: BACKLOG_EVENTS_TYPE, content, display: false },
			{ deliverAs: "steer" },
		);
	}

	/** A user turn: one message with the pending events, a resync note and the task line when it changed. */
	turn(ctx: FeatureContext): string | undefined {
		const b = this.read(ctx);
		if (!b) return undefined;
		const lines: string[] = [];
		if (this.resync) lines.push(RESYNC_NOTICE());
		else if (this.pending.size > 0)
			lines.push(eventsNotice([...this.pending].map(([ref, change]) => describe(ref, change, b)).join("; ")));
		this.resync = false;
		this.pending.clear();
		const snap = backlogQueries.snapshot(this.db(), b.store.repo);
		const changed = [...this.changed];
		const shown = changed.slice(0, MAX_CHANGED);
		if (changed.length > MAX_CHANGED) shown.push(`${changed.length - MAX_CHANGED} more`);
		const line = taskLine(snap, b.session, [], b.actor.item);
		if (line !== this.lastLine || changed.length > 0) lines.push(taskLine(snap, b.session, shown, b.actor.item));
		this.lastLine = line;
		this.changed.clear();
		return lines.length > 0 ? lines.join("\n") : undefined;
	}

	private open(ctx: FeatureContext): Backlog | undefined {
		const env = this.options.env ?? process.env;
		try {
			const agent = sharedAgentDb(env);
			const key = JSON.stringify([
				ctx.cwd,
				ctx.sessionManager.getSessionId(),
				this.options.agentId?.(),
				env[BACKLOG_ITEM_ENV],
				env[PARENT_SESSION_ENV],
			]);
			if (this.opened?.key === key && this.opened.agent === agent) return this.opened.backlog;
			const backlog = openBacklog(ctx, this.options);
			this.opened = { key, agent, backlog };
			return backlog;
		} catch {
			// No board (an unreadable database, a subagent without a parent): nothing to follow; the tool reports why.
			return undefined;
		}
	}

	/** Reads the rows after the cursor when the database file moved since the last read. */
	private read(ctx: FeatureContext): Backlog | undefined {
		if (this.cursor === undefined) return undefined;
		const b = this.open(ctx);
		if (!b) return undefined;
		const stamp = b.store.revision;
		if (stamp === this.lastStamp) return b;
		this.lastStamp = stamp;
		for (;;) {
			const page = backlogQueries.auditAfter(this.db(), b.store.repo, this.cursor, PAGE);
			this.cursor = page.cursor;
			if (page.resync) {
				// Rows were pruned before they were read: one note to re-read replaces whatever was collected.
				this.resync = true;
				this.pending.clear();
				return b;
			}
			for (const row of page.rows) this.take(row, b);
			if (!page.more) return b;
		}
	}

	private take(row: AuditRow, b: Backlog): void {
		const by = actorId(row.actor);
		if (by === b.actor.id) return;
		const ref = row.backlog_id;
		this.changed.add(ref);
		if (row.entity !== "backlog") return;
		const holder = holders(b);
		const heldBefore = row.before_assignee !== null && holder.has(row.before_assignee);
		const held = b.actor.item
			? ref === b.actor.item
			: heldBefore || (row.assignee !== null && holder.has(row.assignee));
		if (!held) return;
		const earlier = this.pending.get(ref);
		this.pending.set(ref, { row, heldBefore: earlier?.heldBefore ?? heldBefore, by: by ?? "unknown" });
	}
}

const finished = (row: AuditRow) => row.closed === 1 || row.state === "done";
const lostHold = (change: Change, b: Backlog) =>
	change.heldBefore && (change.row.assignee === null || !holders(b).has(change.row.assignee));

/** Closed, finished, released or reassigned elsewhere: the agent should not keep working on it. */
function isUrgent(change: Change, b: Backlog): boolean {
	return finished(change.row) || lostHold(change, b);
}

/** `B1 v5 closed by X`, `B2 v4 todo "title" released by X`, `B3 v6 ongoing "title" by X`. */
function describe(ref: string, change: Change, b: Backlog): string {
	const { row, by } = change;
	const head = `${ref} v${row.version ?? "?"}`;
	if (row.closed === 1) return `${head} closed by ${by}`;
	if (row.state === "done") return `${head} done by ${by}`;
	const title = row.title ? ` "${clip(row.title.replace(/\s+/g, " "), TITLE_CHARS)}"` : "";
	const what = lostHold(change, b) ? (row.assignee ? ` reassigned to ${row.assignee}` : " released") : "";
	return `${head} ${row.state ?? ""}${title}${what} by ${by}`;
}

/**
 * The follower's hooks: a new span's baseline at each session start, urgent events after each tool result and when the
 * database moves during a run (`poke`), the rest at the next user turn. Registered before the digest, whose result the
 * turn's other handlers follow.
 */
export function registerTaskEvents(
	api: FeatureSetup,
	options: BacklogOptions,
	/** More lines for the turn's message (the related-agent FYIs). */
	extra?: () => string | undefined,
): { poke: (ctx: FeatureContext) => void } {
	const events = new TaskEvents(api, options);
	const active = () => api.tools.getActive().includes("backlog");
	api.bus.on("session_start", (_event, ctx) => events.start(ctx));
	api.bus.on("tool_result", async (_event, ctx) => {
		if (active()) await events.urgent(ctx);
		return undefined;
	});
	api.bus.on("before_agent_start", (event, ctx) => {
		// A turn the agent starts itself (a custom message) keeps the events for the next user turn.
		if (!active() || event.messageType === "custom") return undefined;
		const content = [events.turn(ctx), extra?.()].filter(Boolean).join("\n");
		return content ? { message: { customType: BACKLOG_EVENTS_TYPE, content, display: false } } : undefined;
	});
	return {
		poke: (ctx) => {
			// A database change has no awaiting caller: a failed notice goes to the problems log.
			if (active() && !ctx.isIdle())
				void events
					.urgent(ctx)
					.catch((error: unknown) => recordProblem("backlog", `Backlog events not sent: ${errorMessage(error)}`));
		},
	};
}
