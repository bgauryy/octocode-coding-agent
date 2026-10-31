import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Message } from "./model.ts";
import { sessionTree } from "./routing.ts";
import type { Resumer } from "./session/send.ts";
import type { TeamStore } from "./store.ts";

/** What relaying reads of the team (`Team`): this agent's id, the subagents it started, and the resumer. */
interface RelaySource {
	id(): string | undefined;
	readonly finished: ReadonlyMap<string, string>;
	/** Whether this session started agent `id`, live or finished: a relay's sender may have exited before this tick. */
	started(id: string): boolean;
	resumer(): Resumer | undefined;
}

/** Relay resumes of one target within `RESUME_WINDOW_MS`: past it, its mail is dead-lettered for the parent's model to judge. */
const RESUMES_PER_WINDOW = 3;
const RESUME_WINDOW_MS = 10 * 60_000;
/** How long requests wait for a resumed target to rejoin the team before they are settled without it. */
const REJOIN_MS = 60_000;

/**
 * The parent side of the B200 relay, run by `Delivery` on every tick before mail is handed to the model: a child's
 * message to an agent it cannot reach waits as a relay request (`TeamStore.refs.relays`). The parent process, not its
 * model, settles each one: a target that is live again gets the message in its inbox; a finished subagent of this
 * session that lingers is resumed with it (the resumer's permission check still applies); anything else becomes a dead
 * letter whose reason the child reads, naming `report:<id>`. Only a sender this agent started is relayed.
 *
 * No model-free resume loop is possible: only a question (`replyRequired`), or the answer to a question the target itself
 * asked, resumes a finished target; an FYI or a thank-you never does. Questions are model decisions, and still each
 * target is resumed by relay at most `RESUMES_PER_WINDOW` times per `RESUME_WINDOW_MS`.
 */
export class Relays {
	private readonly host: RelaySource;
	/** Targets being resumed, with when the resume settled (undefined while it runs): their requests wait for them to rejoin. */
	private readonly resuming = new Map<string, number | undefined>();
	/** When each target was resumed by relay, within the budget window. */
	private readonly resumed = new Map<string, number[]>();
	constructor(host: RelaySource) {
		this.host = host;
	}

	/** Takes the waiting requests (synchronously, in the tick); resumes run in the background. */
	take(db: TeamStore, now = Date.now()): void {
		const me = this.host.id();
		if (!me) return;
		const requests = db.refs.relays(me);
		if (requests.length === 0) return;
		const members = db.list();
		const tree = sessionTree(members, me);
		const live = new Set(members.map((member) => member.id));
		const reachable = (target: string) => live.has(target) && tree.has(target);
		for (const [target, settled] of this.resuming)
			if (reachable(target) || (settled !== undefined && now - settled >= REJOIN_MS)) this.resuming.delete(target);
		const resumable = (target: string) => !reachable(target) && this.host.finished.has(target) && !!this.host.resumer();
		// A target one of these requests resumes: its other requests wait for it rather than being settled without it.
		const wanted = new Set(
			requests
				.filter(({ message, target }) => resumable(target) && this.wakes(db, message, target))
				.map((r) => r.target),
		);
		for (const { message, target } of requests) {
			const ours = message.from !== me && (tree.has(message.from) || this.host.started(message.from));
			const wakes = ours && resumable(target) && this.wakes(db, message, target);
			// Left unclaimed: delivered to the target's inbox once it rejoins, or settled when its resume ends without it.
			if (ours && resumable(target) && (this.resuming.has(target) || (!wakes && wanted.has(target)))) continue;
			if (!db.refs.claimRelay(message.id, me)) continue;
			if (!ours) this.fail(db, me, message, target, `${me} relays only messages from agents it started.`);
			else if (reachable(target)) db.refs.deliverRelay(message.id, me, target, false);
			else if (!resumable(target))
				this.fail(
					db,
					me,
					message,
					target,
					`no agent "${target}" is running, and your parent ${me} cannot resume one by that name (live in your session: ${[...tree].filter((id) => id !== message.from).join(", ") || "none"}). ${cited(me, target)}`,
				);
			else if (!wakes)
				this.fail(
					db,
					me,
					message,
					target,
					`${target} has finished, and a message that asks no question does not resume a finished agent. Send it with replyRequired if you need an answer. ${cited(me, target)}`,
				);
			else if (this.overBudget(target, now))
				this.fail(
					db,
					me,
					message,
					target,
					`${target} was already resumed ${RESUMES_PER_WINDOW} times by relay in the last ${RESUME_WINDOW_MS / 60_000} minutes. ${cited(me, target)}`,
				);
			else {
				this.resuming.set(target, undefined);
				void this.resume(db, me, message, target).then((started) => {
					if (!started) this.resuming.delete(target);
					else if (this.resuming.has(target)) this.resuming.set(target, Date.now());
				});
			}
		}
	}

	/** Whether `message` may resume finished `target`: it asks a question, or answers a question `target` asked. */
	private wakes(db: TeamStore, message: Message, target: string): boolean {
		if (message.replyRequired) return true;
		if (message.replyTo === undefined) return false;
		const question = db.replyTarget(message.replyTo);
		return question?.from === target && question.replyRequired;
	}

	/** Counts a resume of `target` unless it is over the budget; whether it was. */
	private overBudget(target: string, now: number): boolean {
		const recent = (this.resumed.get(target) ?? []).filter((at) => now - at < RESUME_WINDOW_MS);
		if (recent.length >= RESUMES_PER_WINDOW) return true;
		this.resumed.set(target, [...recent, now]);
		return false;
	}

	private fail(db: TeamStore, me: string, message: Message, target: string, reason: string): void {
		try {
			db.refs.failRelay(message.id, me, target, reason);
		} catch {
			// A closed or busy database: the request stays taken; `retire` dead-letters it when this agent leaves the team.
		}
	}

	/** Resumes `target` with the relayed message; whether its run started (else the request is a dead letter). */
	private async resume(db: TeamStore, me: string, message: Message, target: string): Promise<boolean> {
		const resumer = this.host.resumer();
		try {
			// Recorded as handed over first, so the resumed run's inbox never hands it over a second time.
			db.refs.deliverRelay(message.id, me, target, true);
			const receipt = await resumer?.(target, message.text, me, undefined, { message });
			if (receipt) return true;
			this.fail(
				db,
				me,
				message,
				target,
				`${target} has finished and its follow-up window has ended. ${cited(me, target)}`,
			);
		} catch (error) {
			this.fail(
				db,
				me,
				message,
				target,
				`${target} could not be resumed (${errorMessage(error)}). ${cited(me, target)}`,
			);
		}
		return false;
	}
}

const cited = (me: string, target: string) =>
	`If ${target} finished, its report is report:${target}: ask your parent ${me} for it, or to start a new agent with it.`;
