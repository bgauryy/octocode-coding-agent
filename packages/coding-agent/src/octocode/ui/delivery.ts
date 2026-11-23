import { GLYPH } from "@octocodeai/octocode-tui";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { notify } from "../shared/commands.ts";
import { plural } from "../shared/text.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { STATUS } from "../shared/status.ts";

type Send = FeatureSetup["session"]["sendMessage"];
type Message = Parameters<Send>[0];
type Options = Parameters<Send>[1];

/**
 * Keeps feature messages (subagent reports, background job reports, teammate messages) that `api.session.sendMessage` queued
 * during a run from being lost.
 *
 * While a run is active, a message that may start a turn joins Octocode's steering or follow-up queue. Octocode shows only the
 * user's own queued text, and when the user presses Esc (or dequeues) it clears the whole queue but puts back only
 * that text. This ledger records each queued message by its `details` object, which Octocode keeps on the message it later
 * starts. A message still unstarted when the run settles was dropped: a user Stop or a dequeue cleared the queue, from
 * any interface. It is appended to the conversation without starting a turn: the user interrupted, so nothing restarts,
 * but nothing is lost. A status segment shows how many messages wait meanwhile.
 *
 * Installed on `api` itself, before any feature registers, so every `api.session.sendMessage` call goes through it. Messages
 * without a details object, `nextTurn` messages and `triggerTurn: false` messages are not queued this way and pass
 * through untracked.
 */
function stillQueued(ctx: FeatureContext, details: object): boolean {
	try {
		return ctx.isMessageQueued(details);
	} catch {
		// A replaced session's context refuses calls; its queue is gone.
		return false;
	}
}

export class Delivery {
	private readonly waiting = new Map<object, { message: Message; accepted?: Promise<void> }>();
	private running = false;
	private ctx: FeatureContext | undefined;
	private generation = 0;

	private readonly send: Send;
	constructor(send: Send) {
		this.send = send;
	}

	static install(api: FeatureSetup): Delivery {
		const delivery = new Delivery(api.session.sendMessage);
		api.session.sendMessage = (message, options) => delivery.deliver(message, options);
		api.bus.on("session_start", async (_event, ctx) => delivery.reset(ctx));
		api.bus.on("session_shutdown", async () => delivery.reset(undefined));
		api.bus.on("agent_start", async (_event, ctx) => {
			delivery.ctx = ctx;
			delivery.running = true;
		});
		api.bus.on("message_start", async (event) => {
			const { message } = event;
			if (message.role === "custom" && isRecord(message.details) && delivery.waiting.delete(message.details))
				delivery.paint();
		});
		api.bus.on("agent_settled", async (_event, ctx) => delivery.settle(ctx));
		return delivery;
	}

	/** Messages queued and not started yet. */
	get pending(): number {
		return this.waiting.size;
	}

	deliver(message: Message, options?: Options): ReturnType<Send> {
		// Octocode queues once a run starts preparing, before `agent_start` (its `before_agent_start` handlers run in between).
		const busy = this.running || this.preparing();
		const sent = this.send(message, options);
		const queued = busy && options?.triggerTurn !== false && options?.deliverAs !== "nextTurn";
		if (!queued || !isRecord(message.details)) return sent;
		const details = message.details;
		const accepted = sent && typeof sent.then === "function" ? Promise.resolve(sent) : undefined;
		const entry = { message, accepted };
		this.waiting.set(details, entry);
		this.paint();
		if (!accepted) return sent;
		const generation = this.generation;
		const result = accepted.catch((error: unknown) => {
			if (generation === this.generation && this.waiting.get(details) === entry) {
				this.waiting.delete(details);
				this.paint();
			}
			throw error;
		});
		// Some feature notices intentionally fire and forget; keep their rejection observable to awaiting callers.
		void result.catch(() => {});
		return result;
	}

	/** A run is starting but has not reached `agent_start`. */
	private preparing(): boolean {
		try {
			return this.ctx !== undefined && !this.ctx.isIdle();
		} catch {
			// The session was replaced.
			return false;
		}
	}

	/** The run is over: Octocode starts queued messages before it settles, so any still waiting were cleared. */
	private async settle(ctx: FeatureContext): Promise<void> {
		this.running = false;
		this.ctx = ctx;
		const generation = this.generation;
		const dropped: Array<{ message: Message; accepted?: Promise<void> }> = [];
		for (const [details, entry] of this.waiting) {
			// An abort that leaves the agent's queue (a peer's held mail, a compaction, a replacement) leaves the message
			// there: the next run delivers it, so it stays counted and is not appended a second time.
			if (stillQueued(ctx, details)) continue;
			this.waiting.delete(details);
			dropped.push(entry);
		}
		this.paint();
		// Whatever cleared the queue (a user Stop or a dequeue, from the TUI, RPC or the application port), these are
		// verifiably no longer in it: without the re-append a report waits for shutdown and handed mail blocks the inbox.
		if (dropped.length === 0) return;
		let kept = 0;
		const failures: string[] = [];
		for (const { message, accepted } of dropped) {
			try {
				await accepted;
			} catch {
				// The original handoff failed; its caller receives the rejection and owns recovery.
				continue;
			}
			if (generation !== this.generation) return;
			try {
				await this.send(message, { triggerTurn: false });
				if (generation !== this.generation) return;
				kept += 1;
			} catch (error) {
				if (generation !== this.generation) return;
				// The session ended meanwhile: this message is lost, and the notice says so.
				failures.push(errorMessage(error));
			}
		}
		if (!ctx.hasUI) return;
		try {
			if (kept > 0)
				notify(
					ctx.ui,
					`Interrupt kept ${plural(kept, "queued message")}: added to the conversation without starting a turn.`,
					"info",
				);
			if (failures.length > 0)
				notify(
					ctx.ui,
					`Interrupt lost ${plural(failures.length, "queued message")}: could not add ${failures.length === 1 ? "it" : "them"} to the conversation (${failures[0]}).`,
					"warning",
				);
		} catch {
			// The session was replaced: nobody is left to tell.
		}
	}

	private reset(ctx: FeatureContext | undefined): void {
		this.generation++;
		this.waiting.clear();
		this.running = false;
		// The new session's UI is painted (a replaced session's status clears through it); a shutdown clears its own UI.
		if (ctx) this.ctx = ctx;
		this.paint();
		this.ctx = ctx;
	}

	private paint(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(
				STATUS.queued,
				this.waiting.size > 0 ? `${GLYPH.message} ${this.waiting.size} queued` : undefined,
				"accent",
			);
		} catch {
			// The session was replaced.
		}
	}
}
